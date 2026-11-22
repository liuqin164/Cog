export const UI_SLOTS = ['sidebar', 'page', 'chat-card', 'inspector', 'settings'] as const;
export type UiSlot = (typeof UI_SLOTS)[number];

export interface UiField {
  name: string;
  label?: string;
  secret?: boolean;
}

export interface UiPostAction {
  method: 'POST';
  path: string;
  body?: Record<string, unknown>;
}

export type UiNode =
  | { type: 'heading'; text: string; level?: 2 | 3 }
  | { type: 'text'; text: string }
  | { type: 'badge'; text: string; tone?: 'ok' | 'warn' | 'error' | 'dim' }
  | { type: 'kv'; items: Array<{ label: string; value: string }> }
  | { type: 'code'; text: string }
  | { type: 'button'; label: string; action: UiPostAction; primary?: boolean; disabled?: boolean }
  | { type: 'credential-form'; requestId: string; service: string; purpose: string; fields: UiField[]; submitLabel?: string; onSaved: UiPostAction }
  | { type: 'approval'; proposalId: string; title?: string; detail?: string }
  | { type: 'section'; title?: string; nodes: UiNode[] }
  | { type: 'grid'; nodes: UiNode[] };

export interface UiContribution {
  id: string;
  slot: UiSlot;
  title?: string;
  label?: string;
  order?: number;
  channelId?: string;
  render(): UiNode[];
}

export interface UiCard {
  id: string;
  slot: UiSlot;
  title?: string;
  label?: string;
  order?: number;
  channelId?: string;
  nodes: UiNode[];
}

export class UiRegistry {
  private readonly contributions = new Map<string, UiContribution>();

  register(contribution: UiContribution): () => void {
    if (this.contributions.has(contribution.id)) throw new Error(`ui_contribution_already_registered: ${contribution.id}`);
    this.contributions.set(contribution.id, contribution);
    return () => {
      if (this.contributions.get(contribution.id) === contribution) this.contributions.delete(contribution.id);
    };
  }

  unregister(id: string): void {
    this.contributions.delete(id);
  }

  list(): UiCard[] {
    return [...this.contributions.values()]
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100) || left.id.localeCompare(right.id))
      .map((contribution) => {
        let nodes: UiNode[];
        try {
          nodes = contribution.render();
        } catch (error) {
          nodes = [{ type: 'text', text: error instanceof Error ? error.message : String(error) }];
        }
        return {
          id: contribution.id,
          slot: contribution.slot,
          ...(contribution.title === undefined ? {} : { title: contribution.title }),
          ...(contribution.label === undefined ? {} : { label: contribution.label }),
          ...(contribution.order === undefined ? {} : { order: contribution.order }),
          ...(contribution.channelId === undefined ? {} : { channelId: contribution.channelId }),
          nodes,
        };
      });
  }
}
