import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { candidateContentHash } from '../src/governance/CandidateReviewService.js';

const app = readFileSync(join(import.meta.dir, '../src/observatory/web/app.js'), 'utf8');

function sourceOf(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`missing_function:${name}`);
  return app.slice(start, end + 3);
}

function load<T>(...names: string[]): T {
  return new Function(`${names.map(sourceOf).join('\n')}\nreturn { ${names.join(', ')} };`)() as T;
}

const { candidateContent, candidateBatchConfirm } = load<{
  candidateContent: (candidate: { content: unknown }) => string;
  candidateBatchConfirm: (label: string, selected: Array<{ candidateId: string; content: unknown }>) => string;
}>('candidateContent', 'candidatePreview', 'candidateBatchConfirm');

const longBody = {
  preference: '先给计划再动手',
  boundary: '未经确认不发布',
  padding: 'x'.repeat(300),
};
const longCandidate = { candidateId: 'cand-long', content: longBody, contentHash: candidateContentHash(longBody) };
const shortBody = { preference: '先给计划再动手' };
const shortCandidate = { candidateId: 'cand-short', content: shortBody, contentHash: candidateContentHash(shortBody) };

describe('the candidate content the owner approves is the content the server hashed (#486)', () => {
  test('a candidate longer than 260 characters is rendered in full, not cut off', () => {
    const text = candidateContent(longCandidate);
    expect(text.length).toBeGreaterThan(260);
    expect(text).toBe(JSON.stringify(longBody, null, 2));
    expect(text).toContain('x'.repeat(300));
  });

  test('a candidate within 260 characters keeps its inline form', () => {
    const text = candidateContent(shortCandidate);
    expect(text.length).toBeLessThanOrEqual(260);
    expect(text).toBe(JSON.stringify(shortBody, null, 2));
  });

  test('the batch confirmation lists the first three lines of every selected candidate', () => {
    const dialog = candidateBatchConfirm('批准', [longCandidate, shortCandidate]);
    expect(dialog).toContain('对 2 条候选执行「批准」？');
    expect(dialog).toContain('cand-long');
    expect(dialog).toContain('cand-short');
    expect(dialog).toContain(candidateContent(longCandidate).split('\n').slice(0, 3).join('\n'));
    expect(dialog).toContain(candidateContent(shortCandidate));
    expect(dialog).toContain('…');
  });

  test('approval still submits the full-content hash, never the preview or the expanded text', () => {
    expect(longCandidate.contentHash).toBe(candidateContentHash(longBody));
    expect(longCandidate.contentHash).not.toBe(candidateContentHash(candidateContent(longCandidate).split('\n').slice(0, 3).join('\n')));
    const review = app.slice(app.indexOf('async function reviewCandidate('), app.indexOf('async function reviewCandidateBatch('));
    expect(review).toContain('contentHash: candidate.contentHash');
    expect(review).not.toContain('candidateContent');
    expect(review).not.toContain('candidatePreview');
  });

  test('the row starts with the full content open and disables promote when it is collapsed', () => {
    expect(app).toContain("const details = text.length > 260 ? el('details', { class: 'candidate-content', open: true }");
    expect(app).toContain("details.addEventListener('toggle', () => { promote.disabled = !details.open; })");
    expect(app).toContain('details ?? el(\'pre\', { class: \'json\', text })');
    expect(app).toContain('confirm(candidateBatchConfirm(label, selected))');
    expect(app).not.toContain('text.slice(0, 260)');
  });
});
