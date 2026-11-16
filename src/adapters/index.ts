import type { SourceAdapter, SourceAdapterKind } from './types.js';
import { ConversationMarkdownAdapter } from './conversation/ConversationMarkdownAdapter.js';
import { HermesStateDbAdapter } from './hermes/HermesStateDbAdapter.js';
import { OpenClawDailyMemoryAdapter } from './openclaw/OpenClawDailyMemoryAdapter.js';
import { OpenClawMemoryIndexAdapter } from './openclaw/OpenClawMemoryIndexAdapter.js';
import { OpenClawPersonaAdapter } from './openclaw/OpenClawPersonaAdapter.js';
import { OpenClawSessionAdapter } from './openclaw/OpenClawSessionAdapter.js';
import { OpenClawUserProfileAdapter } from './openclaw/OpenClawUserProfileAdapter.js';
import { SkillMarkdownAdapter } from './skill/SkillMarkdownAdapter.js';
import { SoulMarkdownAdapter } from './soul/SoulMarkdownAdapter.js';

export * from './types.js';
export { MarkdownSourceLoader } from './MarkdownSourceLoader.js';
export { ConversationMarkdownAdapter } from './conversation/ConversationMarkdownAdapter.js';
export { SkillMarkdownAdapter, skillSourceDefinition } from './skill/SkillMarkdownAdapter.js';
export { SoulMarkdownAdapter } from './soul/SoulMarkdownAdapter.js';
export { OpenClawDailyMemoryAdapter } from './openclaw/OpenClawDailyMemoryAdapter.js';
export { OpenClawSessionAdapter } from './openclaw/OpenClawSessionAdapter.js';
export { OpenClawMemoryIndexAdapter } from './openclaw/OpenClawMemoryIndexAdapter.js';
export { OpenClawUserProfileAdapter } from './openclaw/OpenClawUserProfileAdapter.js';
export { OpenClawPersonaAdapter } from './openclaw/OpenClawPersonaAdapter.js';
export { OpenClawWorkspaceProfile } from './openclaw/OpenClawWorkspaceProfile.js';
export type {
  OpenClawClassifiedPath,
  OpenClawWorkspaceSelection,
  OpenClawWorkspaceSelectionDiagnostic,
  OpenClawWorkspaceSourceOptions,
} from './openclaw/OpenClawWorkspaceProfile.js';
export { HermesStateDbAdapter } from './hermes/HermesStateDbAdapter.js';
export { HermesWorkspaceProfile } from './hermes/HermesWorkspaceProfile.js';
export type { HermesWorkspaceSourceOptions } from './hermes/HermesWorkspaceProfile.js';

/** Every shipped source adapter, in one place so a new one cannot land in only two of three maps. */
export function createSourceAdapterMap(): Map<SourceAdapterKind, SourceAdapter> {
  return new Map<SourceAdapterKind, SourceAdapter>([
    ['conversation_markdown', new ConversationMarkdownAdapter()],
    ['skill_markdown', new SkillMarkdownAdapter()],
    ['soul_markdown', new SoulMarkdownAdapter()],
    ['hermes_state_db', new HermesStateDbAdapter()],
    ['openclaw_daily_memory', new OpenClawDailyMemoryAdapter()],
    ['openclaw_session', new OpenClawSessionAdapter()],
    ['openclaw_memory_index', new OpenClawMemoryIndexAdapter()],
    ['openclaw_user_profile', new OpenClawUserProfileAdapter()],
    ['openclaw_persona', new OpenClawPersonaAdapter()],
  ]);
}
