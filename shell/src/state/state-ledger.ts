import { redactSecretText, type MemoryKernel } from 'cogmem';

export interface RuntimeTextLedger {
  record(kind: string, text: string): string;
  read(eventId: string): string | undefined;
  has(eventId: string, text: string): boolean;
}

export class ShellStateLedger implements RuntimeTextLedger {
  private readonly byText = new Map<string, string>();
  private readonly byId = new Map<string, string>();

  constructor(
    private readonly store: MemoryKernel['eventStore'],
    private readonly projectId: string,
  ) {}

  record(kind: string, text: string): string {
    const key = `${kind}\0${text}`;
    const existing = this.byText.get(key);
    if (existing !== undefined) return existing;
    const stored = redactSecretText(text).text;
    const event = this.store.append({
      streamId: `shell-state:${this.projectId}:${kind}`,
      streamType: 'system',
      eventType: 'SHELL_STATE_RECORDED',
      projectId: this.projectId,
      payload: { kind, text: stored },
    });
    this.remember(event.eventId, key, stored);
    return event.eventId;
  }

  read(eventId: string): string | undefined {
    const cached = this.byId.get(eventId);
    if (cached !== undefined) return cached;
    const payload = (this.store.getEvent(eventId)?.payload ?? {}) as { kind?: unknown; text?: unknown };
    if (typeof payload.kind !== 'string' || typeof payload.text !== 'string') return undefined;
    this.remember(eventId, `${payload.kind}\0${payload.text}`, payload.text);
    return payload.text;
  }

  has(eventId: string, text: string): boolean {
    const cached = this.byId.get(eventId);
    const stored = redactSecretText(text).text;
    return cached !== undefined ? cached === stored : this.read(eventId) === stored;
  }

  forget(): void {
    this.byText.clear();
    this.byId.clear();
  }

  private remember(eventId: string, key: string, text: string): void {
    this.byText.set(key, eventId);
    this.byId.set(eventId, text);
  }
}
