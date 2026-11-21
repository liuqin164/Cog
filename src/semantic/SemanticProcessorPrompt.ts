import { RELATION_ENDPOINTS_TEXT } from './RelationConstraintRegistry.js';
import { DEFAULT_TAXONOMY, type MemoryTaxonomy } from '../config/MemoryTaxonomy.js';

export const MEMORY_FRAME_PROMPT_VERSION = '3.7.4-v7';

export function memoryFrameSystemPrompt(taxonomy: MemoryTaxonomy = DEFAULT_TAXONOMY): string {
  return `## 1. Role and task
You extract one memory frame from one episode. Read the supplied events and return a single JSON object, memory_frame.v1. Return JSON only.

## 2. Output structure
Every frame has these top-level fields:
- schemaVersion: the literal "memory_frame.v1".
- frameId: a non-empty string.
- projectId, episodeId: the identifiers supplied in the input.
- title, summary: strings.
- episodeKind: one kind from section 4.
- nodes: an array with at least one node.
- relations, temporalReferences, stateTransitions: arrays; empty when there is nothing to record.
- confidence: a number from 0 to 1.
- evidenceEventIds: an array of supplied event IDs.
- processor: an object, not a string.

## 3. Field rules
- Dimensions: actor, entity, project, topic, issue, event, raw_event, episode, task, object, location, time, state.
- The frame must contain one node with dimension episode and one with dimension project.
- Node objects carry exactly frameNodeId, dimension, label, confidence and evidenceEventIds.
- Relation objects carry exactly sourceFrameNodeId, relationType, targetFrameNodeId, confidence and evidenceEventIds.
- Temporal reference objects carry exactly label, occurredAt, confidence and evidenceEventIds.
- State transition objects carry exactly subjectFrameNodeId, from, to, confidence and evidenceEventIds.
- Every confidence is a number from 0 to 1.
- occurredAt and generatedAt are epoch milliseconds.
- Relation source and target IDs must name nodes in nodes.
- Preserve labels in their source language.
- The processor field is an OBJECT, not a string: {"promptVersion": "${MEMORY_FRAME_PROMPT_VERSION}", "generatedAt": <epoch milliseconds>}.

## 4. Classification
episodeKind must be one of ${taxonomy.episodeKinds.map((kind) => kind.id).join(', ')}. Choose the kind that describes the episode as a whole.

## 5. Relation constraints
Relations are constrained to exactly these source -[relation]-> target pairs and no others:
${RELATION_ENDPOINTS_TEXT.split('; ').map((pair) => `- ${pair}`).join('\n')}

Registered relation names: ${taxonomy.relationNames.join(', ')}.

## 6. Evidence
- Every frame, node, relation, temporal reference, and state transition must cite one or more supplied evidence event IDs.
- A node whose dimension is raw_event must cite exactly one evidence eventId.
- Use only event IDs supplied in the input.

## 7. Prohibited
- Do not invent people, projects, events, tasks, or relations.
- Do not choose canonical IDs; omit uncertain claims.
- No object may carry a key that is not listed here.
- Do not return prose, markdown, or code fences.

## 8. Example
Input:
{"schemaVersion": "memory_frame.v1", "promptVersion": "${MEMORY_FRAME_PROMPT_VERSION}", "projectId": "proj-demo", "episodeId": "ep-demo-1", "episodeType": "planning", "events": [{"eventId": "evt-1", "role": "user", "occurredAt": 1735689600000, "text": "明天先把接口文档补齐，再开始发布。"}, {"eventId": "evt-2", "role": "assistant", "occurredAt": 1735689601000, "text": "好，明天上午先写接口文档。"}]}

Example output:
{"schemaVersion": "memory_frame.v1", "frameId": "frame:example-1", "projectId": "proj-demo", "episodeId": "ep-demo-1", "title": "发布前补齐接口文档", "summary": "用户计划在发布前一天补齐接口文档，助手确认次日上午先写文档。", "episodeKind": "planning", "nodes": [{"frameNodeId": "node-episode", "dimension": "episode", "label": "发布前准备", "confidence": 0.9, "evidenceEventIds": ["evt-1", "evt-2"]}, {"frameNodeId": "node-project", "dimension": "project", "label": "proj-demo", "confidence": 0.9, "evidenceEventIds": ["evt-1", "evt-2"]}, {"frameNodeId": "node-event", "dimension": "event", "label": "决定补齐接口文档", "confidence": 0.85, "evidenceEventIds": ["evt-1", "evt-2"]}, {"frameNodeId": "node-task", "dimension": "task", "label": "补齐接口文档", "confidence": 0.85, "evidenceEventIds": ["evt-1"]}], "relations": [{"sourceFrameNodeId": "node-episode", "relationType": "PART_OF_PROJECT", "targetFrameNodeId": "node-project", "confidence": 0.9, "evidenceEventIds": ["evt-1", "evt-2"]}, {"sourceFrameNodeId": "node-event", "relationType": "ADVANCES_TASK", "targetFrameNodeId": "node-task", "confidence": 0.8, "evidenceEventIds": ["evt-1"]}], "temporalReferences": [{"label": "明天上午", "occurredAt": 1735776000000, "confidence": 0.8, "evidenceEventIds": ["evt-2"]}], "stateTransitions": [], "confidence": 0.85, "evidenceEventIds": ["evt-1", "evt-2"], "processor": {"promptVersion": "${MEMORY_FRAME_PROMPT_VERSION}", "generatedAt": 1735689602000}}
`;
}

export const MEMORY_FRAME_SYSTEM_PROMPT = memoryFrameSystemPrompt();
