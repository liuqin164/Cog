import { expect, test } from 'bun:test';
import { MEMORY_FRAME_PROMPT_VERSION, MEMORY_FRAME_SYSTEM_PROMPT } from '../src/semantic/SemanticProcessorPrompt.js';
import { validateMemoryFrame } from '../src/semantic/MemoryFrameValidator.js';

test('the frame prompt is sectioned and its example is a valid frame', () => {
  for (const heading of ['1. Role and task', '2. Output structure', '3. Field rules', '4. Classification', '5. Relation constraints', '6. Evidence', '7. Prohibited', '8. Example']) {
    expect(MEMORY_FRAME_SYSTEM_PROMPT).toContain(`## ${heading}`);
  }
  const output = MEMORY_FRAME_SYSTEM_PROMPT.slice(MEMORY_FRAME_SYSTEM_PROMPT.indexOf('Example output:'));
  const frame = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  expect(validateMemoryFrame(frame).valid).toBe(true);
  expect(frame.processor.promptVersion).toBe(MEMORY_FRAME_PROMPT_VERSION);
});
