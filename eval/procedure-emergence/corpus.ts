/**
 * #265 — ten repeatable file/shell chores for the procedure-emergence A/B.
 *
 * Each task has a setup (the files the workspace starts with), a first prompt, and a repeat
 * prompt that asks for the same work in different words. The repeat prompt is what the A/B's
 * second attempt sees; the checker is deterministic and reads the workspace after the run.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  /** Files written into the workspace before every attempt. */
  setup: Record<string, string>;
  prompt: string;
  repeatPrompt: string;
  check: (root: string) => CheckResult;
}

function read(root: string, path: string): string | null {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

function hasAll(text: string | null, needles: string[]): CheckResult {
  if (text === null) return { ok: false, detail: 'file missing' };
  const missing = needles.filter((needle) => !text.includes(needle));
  return missing.length === 0
    ? { ok: true, detail: 'ok' }
    : { ok: false, detail: `missing: ${missing.join(', ')}` };
}

const LOG_LINES = [
  'INFO boot ok',
  'ERROR upload failed: retry exhausted',
  'INFO worker ready',
  'ERROR upload failed: retry exhausted',
  'WARN queue depth 12',
  'INFO heartbeat',
  'ERROR auth token expired',
  'INFO worker ready',
  'ERROR upload failed: retry exhausted',
  'INFO heartbeat',
  'WARN queue depth 40',
  'ERROR disk quota near limit',
  'INFO heartbeat',
  'ERROR auth token expired',
  'INFO worker ready',
  'ERROR upload failed: retry exhausted',
  'INFO heartbeat',
  'WARN queue depth 8',
  'ERROR auth token expired',
  'INFO boot ok',
];

const NOTES = ['# 本周记录', '', '- TODO: 更新回滚文档', '- 已完成：灰度观察', '', '- TODO: 补一条超时告警', '', '- TODO: 整理压测结论', '- 已完成：清理旧日志', '', '- TODO: 确认值班表'].join('\n');

export const TASKS: TaskSpec[] = [
  {
    id: 'shopping',
    title: '购物清单',
    setup: {},
    prompt: '在工作目录创建 shopping.txt，写三行：牛奶、鸡蛋、面包。写完读回来确认。',
    repeatPrompt: '再准备一次购物清单，还是那三样：牛奶、鸡蛋、面包，写到 shopping.txt。',
    check: (root) => hasAll(read(root, 'shopping.txt'), ['牛奶', '鸡蛋', '面包']),
  },
  {
    id: 'gift',
    title: '礼物清单',
    setup: {},
    prompt: '创建 gift.txt，写三行礼物：围巾、茶杯、书。写完确认一下。',
    repeatPrompt: '把礼物清单 gift.txt 再写一次：围巾、茶杯、书。',
    check: (root) => hasAll(read(root, 'gift.txt'), ['围巾', '茶杯', '书']),
  },
  {
    id: 'error-count',
    title: '错误行统计',
    setup: { 'log.txt': `${LOG_LINES.join('\n')}\n` },
    prompt: '统计 log.txt 里含 ERROR 的行数，把数字写进 error_count.txt，只写数字。',
    repeatPrompt: '再数一遍 log.txt 的 ERROR 行数，结果写到 error_count.txt。',
    check: (root) => {
      const text = read(root, 'error_count.txt');
      if (text === null) return { ok: false, detail: 'file missing' };
      return text.trim() === '8' ? { ok: true, detail: 'ok' } : { ok: false, detail: `got ${text.trim()}` };
    },
  },
  {
    id: 'todo-extract',
    title: 'TODO 提取',
    setup: { 'notes.md': `${NOTES}\n` },
    prompt: '把 notes.md 里所有 TODO 行提取到 todo.md，一行一条，保留 TODO 后面的内容。',
    repeatPrompt: '把 notes.md 的 TODO 清单重新导出到 todo.md，一行一条。',
    check: (root) => {
      const text = read(root, 'todo.md');
      if (text === null) return { ok: false, detail: 'file missing' };
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      return lines.length === 4 ? { ok: true, detail: 'ok' } : { ok: false, detail: `${lines.length} lines, want 4` };
    },
  },
  {
    id: 'tsv-csv',
    title: 'TSV 转 CSV',
    setup: { 'data.tsv': 'name\tqty\tnote\n苹果\t3\t冷库\n梨\t5\t常温\n桃\t2\t冷库\n' },
    prompt: '把 data.tsv 转成 data.csv（逗号分隔），保留表头。',
    repeatPrompt: 'data.tsv 再转一次 data.csv，逗号分隔，表头保留。',
    check: (root) => {
      const text = read(root, 'data.csv');
      if (text === null) return { ok: false, detail: 'file missing' };
      const lines = text.trim().split('\n');
      const ok = lines.length === 4 && lines[0] === 'name,qty,note' && lines[1] === '苹果,3,冷库';
      return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: lines.slice(0, 2).join(' | ') };
    },
  },
  {
    id: 'config-rename',
    title: '配置键改名',
    setup: { 'config.json': `${JSON.stringify({ retry_limit: 5, mode: 'safe' }, null, 2)}\n` },
    prompt: '把 config.json 里的键 retry_limit 改名为 max_retries，值不变，保持合法 JSON。',
    repeatPrompt: 'config.json 的 retry_limit 再改一次名，改成 max_retries。',
    check: (root) => {
      const text = read(root, 'config.json');
      if (text === null) return { ok: false, detail: 'file missing' };
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        return parsed.max_retries === 5 && !('retry_limit' in parsed) && parsed.mode === 'safe'
          ? { ok: true, detail: 'ok' }
          : { ok: false, detail: text.trim() };
      } catch {
        return { ok: false, detail: 'invalid json' };
      }
    },
  },
  {
    id: 'merge-json',
    title: 'JSON 合并',
    setup: {
      'a.json': `${JSON.stringify({ a: 1, b: 2 }, null, 2)}\n`,
      'b.json': `${JSON.stringify({ b: 3, c: 4 }, null, 2)}\n`,
    },
    prompt: '合并 a.json 和 b.json 成 merged.json，b.json 的值优先。',
    repeatPrompt: '再合并一次 a.json 和 b.json 到 merged.json，b 的值优先。',
    check: (root) => {
      const text = read(root, 'merged.json');
      if (text === null) return { ok: false, detail: 'file missing' };
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const ok = parsed.a === 1 && parsed.b === 3 && parsed.c === 4;
        return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: text.trim() };
      } catch {
        return { ok: false, detail: 'invalid json' };
      }
    },
  },
  {
    id: 'titles',
    title: '标题汇总',
    setup: {
      'a.md': '# 发布\n\n发布流程说明。\n',
      'b.md': '# 巡检\n\n巡检清单。\n',
      'c.md': '# 复盘\n\n复盘结论。\n',
    },
    prompt: '提取 a.md、b.md、c.md 的一级标题到 summary.md，每行一个。',
    repeatPrompt: '把三份文档的一级标题重新汇总到 summary.md。',
    check: (root) => {
      const text = read(root, 'summary.md');
      if (text === null) return { ok: false, detail: 'file missing' };
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      const ok = lines.length === 3 && ['发布', '巡检', '复盘'].every((title) => text.includes(title));
      return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: lines.join(' | ') };
    },
  },
  {
    id: 'fix-script',
    title: '修复脚本',
    setup: { 'run.sh': '#!/usr/bin/env bash\ncat missing.txt\necho done\n' },
    prompt: 'run.sh 运行失败了，修好它，让它能用 bash run.sh 正常输出 done。',
    repeatPrompt: 'run.sh 还有问题，再修一次，确保 bash run.sh 输出 done。',
    check: (root) => {
      const result = spawnSync('/bin/bash', ['run.sh'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      return result.status === 0 && output.includes('done')
        ? { ok: true, detail: 'ok' }
        : { ok: false, detail: `status ${result.status}: ${output.slice(0, 120)}` };
    },
  },
  {
    id: 'list-txt',
    title: '文本文件清单',
    setup: { 'alpha.txt': 'a\n', 'beta.txt': 'b\n', 'notes.md': '# notes\n' },
    prompt: '把工作目录里所有 .txt 文件名按字母顺序写进 list.txt，每行一个。',
    repeatPrompt: '重新生成 list.txt：列出目录下所有 .txt 文件名，排好序。',
    check: (root) => {
      const text = read(root, 'list.txt');
      if (text === null) return { ok: false, detail: 'file missing' };
      const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      return lines.join(',') === 'alpha.txt,beta.txt' ? { ok: true, detail: 'ok' } : { ok: false, detail: lines.join(',') };
    },
  },
];

/** Reset a workspace: remove everything, then write the task's setup files. */
export function resetWorkspace(root: string, task: TaskSpec): void {
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  for (const [path, contents] of Object.entries(task.setup)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
}
