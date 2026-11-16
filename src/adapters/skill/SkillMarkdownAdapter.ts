/**
 * A SKILL.md guide entering through the import channel (#266).
 *
 * The file is read as a document, not as a turn: its frontmatter supplies the procedure descriptor
 * (`name` → key, optional `domain`/`key`, `description` → title, `allowed-tools` → tools) and the
 * body's list items are the quoted steps. The import path adds `metadata.imported: true`, so the
 * procedure book compiles the row as an `imported` guide — recallable, and outranked by an own
 * practice. Nothing is mounted or scanned: the caller names the file.
 */
import { basename, dirname, resolve } from 'node:path';

import type {
  AdaptedSource,
  AdapterWindow,
  SourceAdapter,
  SourceAdapterRecord,
  SourceDefinition,
  SourceFileSnapshot,
} from '../types.js';
import { computeStableHash, normalizeMarkdownText, parseLooseTimestamp } from '../types.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const MAX_SKILL_STEPS = 16;
const MAX_SKILL_TOOLS = 8;

function frontmatterOf(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    let value = line.slice(separator + 1).trim();
    // A folded (`>`) or literal (`|`) scalar is the indented block that follows it.
    if (value === '>' || value === '|') {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) {
        block.push(lines[++index]!.trim());
      }
      value = block.join(value === '>' ? ' ' : '\n');
    }
    value = value.replace(/^["']|["']$/g, '');
    if (key) fields[key] = value;
  }
  return { fields, body: content.slice(match[0].length).trim() };
}

/** The guide's steps, quoted: list items when present, otherwise its paragraphs. */
function stepsOf(body: string): string[] {
  const items = body.split('\n')
    .map((line) => LIST_ITEM_RE.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item));
  const steps = items.length > 0
    ? items
    : body.split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph && !/^#{1,6}\s/.test(paragraph));
  return [...new Set(steps)].slice(0, MAX_SKILL_STEPS);
}

function toolsOf(fields: Record<string, string>): string[] {
  const raw = fields['allowed-tools'] ?? fields.tools ?? '';
  return [...new Set(raw.split(/[,;\s]+/).map((tool) => tool.trim()).filter(Boolean))].slice(0, MAX_SKILL_TOOLS);
}

export function skillSourceDefinition(projectId: string, filePath: string): SourceDefinition {
  const absolute = resolve(filePath);
  return {
    sourceId: `skill-${computeStableHash([projectId, absolute]).slice(0, 12)}`,
    adapterKind: 'skill_markdown',
    sourcePath: absolute,
    projectId,
    tags: ['skill'],
    metadata: { skillImport: true },
  };
}

export class SkillMarkdownAdapter implements SourceAdapter {
  readonly kind = 'skill_markdown' as const;
  private readonly adapterVersion = 'skill-markdown-v1';

  adapt(source: SourceDefinition, snapshot: SourceFileSnapshot, _window?: AdapterWindow): AdaptedSource {
    const { fields, body } = frontmatterOf(normalizeMarkdownText(snapshot.content));
    const name = fields.name?.trim() || basename(dirname(source.sourcePath)) || 'skill';
    const domain = fields.domain?.trim() || 'skill';
    const key = fields.key?.trim() || name;
    const title = fields.description?.trim() || name;
    const steps = stepsOf(body);
    const tools = toolsOf(fields);
    const timestamp = parseLooseTimestamp(fields.date || fields.created_at, snapshot.fileMtimeMs);
    const recordHash = computeStableHash([source.sourceId, this.adapterVersion, name, body]);

    const record: SourceAdapterRecord = {
      recordId: `skill-${recordHash.slice(0, 16)}`,
      kind: 'note',
      role: 'system',
      text: body || title,
      timestamp,
      tags: ['skill', 'source_class:skill'],
      confidenceHint: 0.5,
      sourceTypeHint: 'llm_inference',
      metadata: {
        procedure: {
          domain,
          key,
          title,
          steps,
          tools,
          checklist: fields.checklist === 'true',
        },
        skill: { name, description: fields.description ?? '' },
      },
      provenance: {
        sourceId: source.sourceId,
        sourcePath: source.sourcePath,
        sourceType: this.kind,
        adapterVersion: this.adapterVersion,
        fileHash: snapshot.fileHash,
        fileMtimeMs: snapshot.fileMtimeMs,
        recordHash,
        reliabilityClass: 'imported_summary',
        orderingConfidence: 'high',
      },
    };

    return {
      source,
      snapshot: {
        sourceId: snapshot.sourceId,
        adapterKind: snapshot.adapterKind,
        sourcePath: snapshot.sourcePath,
        projectId: snapshot.projectId,
        fileHash: snapshot.fileHash,
        fileMtimeMs: snapshot.fileMtimeMs,
        fileSize: snapshot.fileSize,
        readAt: snapshot.readAt,
      },
      records: [record],
    };
  }
}
