import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SCENARIOS } from '../eval/behavior/scenarios/index.js';
import { runScenarios } from '../eval/behavior/runner.js';
import {
  BEHAVIOR_EVAL_CONTRACT_VERSION,
  SCENARIO_CATEGORIES,
  SCENARIO_FIELDS,
} from '../eval/behavior/types.js';

/**
 * The F13 behaviour-eval contract (#167). The document's frozen tables are read back and compared
 * with the scenario registry, then every scenario runs in fixture mode. The scenarios themselves
 * carry the written criteria; this file guarantees the register, the four categories and the fault
 * injection protocol stay in step with the code.
 */

const markdown = readFileSync(fileURLToPath(new URL('../docs/behavior-eval.md', import.meta.url)), 'utf8');

function sectionAfter(heading: string): string {
  return markdown.split(heading)[1]?.split(/\n#{2,3} /)[0] ?? '';
}

function firstColumn(section: string): string[] {
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gmu)].map((match) => match[1]!);
}

function scenarioRows(section: string): Array<{ id: string; category: string; title: string }> {
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gmu)].map((match) => ({
    id: match[1]!,
    category: match[2]!,
    title: match[3]!.trim(),
  }));
}

test('the category table is exactly SCENARIO_CATEGORIES, in order', () => {
  expect(firstColumn(sectionAfter('## Categories (frozen)'))).toEqual([...SCENARIO_CATEGORIES]);
});

test('the schema table is exactly SCENARIO_FIELDS, in order', () => {
  expect(firstColumn(sectionAfter('## Scenario schema (frozen)'))).toEqual([...SCENARIO_FIELDS]);
});

test('the scenario register names every scenario with its category and title', () => {
  const rows = scenarioRows(sectionAfter('## Scenario register (frozen)'));
  expect(rows.map((row) => row.id)).toEqual(SCENARIOS.map((scenario) => scenario.id));
  for (const scenario of SCENARIOS) {
    const row = rows.find((candidate) => candidate.id === scenario.id)!;
    expect(row.category).toBe(scenario.category);
    expect(row.title).toBe(scenario.title);
  }
});

test('each category has at least four scenarios, and every scenario has criteria and pinned inputs', () => {
  for (const category of SCENARIO_CATEGORIES) {
    expect(SCENARIOS.filter((scenario) => scenario.category === category).length).toBeGreaterThanOrEqual(4);
  }
  for (const scenario of SCENARIOS) {
    expect(scenario.criteria.length).toBeGreaterThan(0);
    expect(scenario.pinned.length).toBeGreaterThan(0);
  }
  expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
});

test('the fault-injection register names real scenarios and the expected red set', () => {
  const section = sectionAfter('## Fault injection (frozen)');
  const rows = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|([^|]+)\|([^|]+)\|/gmu)];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const expected = [...row[3]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    expect(expected.length).toBeGreaterThan(0);
    for (const id of expected) expect(SCENARIOS.some((scenario) => scenario.id === id)).toBe(true);
  }
  expect(BEHAVIOR_EVAL_CONTRACT_VERSION).toBe(1);
});

test('every scenario passes in fixture mode', async () => {
  const results = await runScenarios(SCENARIOS);
  const failed = results.filter((result) => !result.passed);
  expect(failed).toEqual([]);
  expect(results.length).toBe(SCENARIOS.length);
});
