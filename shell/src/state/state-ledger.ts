import { redactSecretText, type KernelAgentMemoryBackend } from 'cogmem';

import type { RuntimeTextLedger } from './checkpoint.ts';

export class ShellStateLedger implements RuntimeTextLedger {
  private readonly byText = new Map<string, string>();
  private readonly byId = new Map<string, string>();

  constructor(
    private readonly backend: KernelAgentMemoryBackend,
    private readonly projectId: string,
  ) {}

  record(kind: string, text: string): string {
    const key = `${kind}\0${text}`;
    const existing = this.byText.get(key);
    if (existing !== undefined) return existing;
    const stored = redactSecretText(text).text;
    const eventId = this.backend.recordRuntimeText({ projectId: this.projectId, kind, text: stored });
    this.remember(eventId, key, stored);
    return eventId;
  }

  read(eventId: string): string | undefined {
    const cached = this.byId.get(eventId);
    if (cached !== undefined) return cached;
    const stored = this.backend.readRuntimeText(eventId);
    if (stored === undefined) return undefined;
    this.remember(eventId, `${stored.kind}\0${stored.text}`, stored.text);
    return stored.text;
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
