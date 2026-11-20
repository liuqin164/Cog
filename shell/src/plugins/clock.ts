/**
 * The shell's process clock. The agent's own wake intentions live in the kernel's F2 ledger; the
 * checkpoint here holds only process-recovery alarms (`idle_checkin`, `morning_after_dream`, an
 * upgrade report) that must survive a restart before any agent intent exists.
 */
import type { StateMachine } from '../state/machine.ts';
import { isUpgradePromise } from '../upgrade/records.ts';
import type { WakeIntent } from '../state/checkpoint.ts';
import type { NativePlugin } from './host.ts';

export interface ClockConfig {
  timeZone: string;
  idleWakeIntervalMs: number;
  dreamWindow: { startHour: number; endHour: number };
  quietWindow?: { startHour: number; endHour: number };
  /** The process clock; injected so a test can cross a minute boundary on purpose. */
  now?: () => number;
}

export interface TimeContext {
  now: number;
  iso: string;
  timeZone: string;
  localDate: string;
  weekday: string;
  hour: number;
  dayPart: 'morning' | 'afternoon' | 'evening' | 'night';
  lastInteractionAt?: number;
  silentForMs?: number;
  nextWakeAt?: number;
  nextWakeReason?: string;
}

export class ClockService {
  constructor(private readonly machine: StateMachine, private readonly config: ClockConfig, private clock: () => number = config.now ?? Date.now) {}

  now(): number {
    return this.clock();
  }

  localDate(at = this.now()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  }

  timeContext(at = this.now()): TimeContext {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.config.timeZone, hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(at));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
    const dayPart = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 23 ? 'evening' : 'night';
    const runtime = this.machine.runtime;
    const next = this.nextPendingIntent();
    return {
      now: at,
      iso: new Date(at).toISOString(),
      timeZone: this.config.timeZone,
      localDate: this.localDate(at),
      weekday,
      hour,
      dayPart,
      lastInteractionAt: runtime.lastInteractionAt,
      silentForMs: runtime.lastInteractionAt === undefined ? undefined : Math.max(0, at - runtime.lastInteractionAt),
      nextWakeAt: next?.at,
      nextWakeReason: next?.reason,
    };
  }

  /** The block the model sees in place of "I do not know what time it is". */
  timeContextBlock(at = this.now(), extra: string[] = []): string {
    const context = this.timeContext(at);
    const silence = context.silentForMs === undefined ? 'no recorded contact yet' : formatDuration(context.silentForMs);
    const next = context.nextWakeAt === undefined ? 'none scheduled' : `${minuteIso(context.nextWakeAt)} (${context.nextWakeReason})`;
    return [
      '<time-context>',
      // Minute precision, not milliseconds (#320): a prompt cache matches on bytes, so a clock that
      // ticks inside the turn changes the prefix on every request. The model still has the minute.
      `now: ${minuteIso(context.now)} (${context.timeZone}, ${context.weekday} ${context.dayPart})`,
      `local date: ${context.localDate}`,
      `since last contact: ${silence}`,
      `next wake intent: ${next}`,
      ...extra,
      '</time-context>',
    ].join('\n');
  }

  markInteraction(at = this.now()): void {
    this.machine.updateRuntime({ lastInteractionAt: at });
  }

  setWakeIntent(at: number, reason: string): WakeIntent {
    return this.machine.addWakeIntent({ at, reason });
  }

  /** Persist the next wake even when nothing else does: standby is not a heartbeat, it is an intent. */
  scheduleIdleWake(reason = 'idle_checkin'): WakeIntent {
    const pending = this.nextPendingIntent();
    if (pending) return pending;
    return this.setWakeIntent(this.now() + this.config.idleWakeIntervalMs, reason);
  }

  nextPendingIntent(): WakeIntent | undefined {
    return this.machine.wakeIntents.filter((intent) => !intent.consumedAt).sort((a, b) => a.at - b.at)[0];
  }

  dueWakeIntent(at = this.now()): WakeIntent | undefined {
    // `StateMachine.dueWakeIntent` with one exclusion: the upgrade's report promise (#165) is settled
    // by the upgrade path itself, and firing it as an idle wake would consume the obligation without
    // ever speaking the report it exists for. Same order (`wakeIntents` order), same selection.
    return this.machine.wakeIntents.find((intent) => !intent.consumedAt && intent.at <= at && !isUpgradePromise(intent.reason));
  }

  consumeWakeIntent(id: string): void {
    this.machine.consumeWakeIntent(id);
  }

  dreamWindowOpen(at = this.now()): boolean {
    const hour = this.timeContext(at).hour;
    const { startHour, endHour } = this.config.dreamWindow;
    if (startHour < endHour) return hour >= startHour && hour < endHour;
    return startHour > endHour && (hour >= startHour || hour < endHour);
  }

  dreamWindowClosed(at = this.now()): boolean {
    const hour = this.timeContext(at).hour;
    const { startHour, endHour } = this.config.dreamWindow;
    if (startHour < endHour) return hour >= endHour || hour < startHour;
    return startHour > endHour && hour >= endHour && hour < startHour;
  }

  quietWindowOpen(at = this.now()): boolean {
    const window = this.config.quietWindow;
    if (!window) return false;
    const hour = this.timeContext(at).hour;
    if (window.startHour < window.endHour) return hour >= window.startHour && hour < window.endHour;
    return hour >= window.startHour || hour < window.endHour;
  }

  dreamNightDate(at = this.now()): string {
    const date = this.localDate(at);
    return this.timeContext(at).hour >= this.config.dreamWindow.startHour ? date : shiftDate(date, -1);
  }

  dreamTargetDate(at = this.now()): string {
    return shiftDate(this.dreamNightDate(at), -1);
  }

  dreamedNight(at = this.now()): boolean {
    return this.machine.runtime.lastDreamDate === this.dreamTargetDate(at);
  }

  markDreamed(at = this.now()): void {
    this.machine.updateRuntime({ lastDreamDate: this.dreamTargetDate(at) });
  }

  daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  }
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function clockPlugin(config: ClockConfig): NativePlugin {
  return {
    name: 'clock',
    provide: ['clock'],
    apply(ctx) {
      const machine = ctx.getService<StateMachine>('stateMachine');
      ctx.provide('clock', new ClockService(machine, config, config.now));
    },
  };
}

/** ISO-8601 truncated to the minute, in UTC, with the `Z` the model already reads. */
function minuteIso(at: number): string {
  return `${new Date(Math.floor(at / 60_000) * 60_000).toISOString().slice(0, 16)}Z`;
}
