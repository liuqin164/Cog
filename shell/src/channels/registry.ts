export interface ChannelConfigField {
  name: string;
  label?: string;
  secret?: boolean;
}

export type ChannelState = 'disconnected' | 'pairing' | 'connected' | 'error';

export interface ChannelStatus {
  state: ChannelState;
  detail?: string;
  pairingCode?: string;
}

export interface ChannelEntry {
  id: string;
  name: string;
  config: ChannelConfigField[];
  status(): ChannelStatus;
  begin?(): { ok: boolean; requestId?: string; error?: string };
  start?(ref: string): { ok: boolean; error?: string };
  disconnect?(): { ok: boolean; error?: string };
}

export interface ChannelCard extends ChannelStatus {
  id: string;
  name: string;
  config: ChannelConfigField[];
  connectable: boolean;
}

export class ChannelRegistry {
  private readonly entries = new Map<string, ChannelEntry>();

  register(entry: ChannelEntry): () => void {
    if (this.entries.has(entry.id)) throw new Error(`channel_already_registered: ${entry.id}`);
    this.entries.set(entry.id, entry);
    return () => {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    };
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  list(): ChannelCard[] {
    return [...this.entries.values()].map((entry) => {
      let status: ChannelStatus;
      try {
        status = entry.status();
      } catch (error) {
        status = { state: 'error', detail: error instanceof Error ? error.message : String(error) };
      }
      return {
        id: entry.id,
        name: entry.name,
        config: entry.config,
        connectable: Boolean(entry.begin && entry.start),
        ...status,
      };
    });
  }

  begin(id: string): { ok: boolean; requestId?: string; error?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown_channel' };
    if (!entry.begin) return { ok: false, error: 'channel_not_connectable' };
    try {
      return entry.begin();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  start(id: string, ref: string): { ok: boolean; error?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown_channel' };
    if (!entry.start) return { ok: false, error: 'channel_not_connectable' };
    try {
      return entry.start(ref);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  disconnect(id: string): { ok: boolean; error?: string } {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, error: 'unknown_channel' };
    if (!entry.disconnect) return { ok: false, error: 'channel_not_connectable' };
    try {
      return entry.disconnect();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
