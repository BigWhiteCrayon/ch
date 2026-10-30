import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassificationFeedback } from '../src/types';

let log: typeof import('../src/log');
let feedback: typeof import('../src/feedback');
let dir: string;
const file = () => path.join(dir, 'classification-feedback.jsonl');
const lines = () =>
  fs
    .readFileSync(file(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const classification: ClassificationFeedback['classification'] = {
  sophistication: 2,
  effort: 'low',
  category: 'question',
  model: 'llama3.2:3b',
};
const verdict = (more: Partial<ClassificationFeedback> = {}): ClassificationFeedback => ({
  rating: 'good',
  request: 'What is a closure?',
  classification,
  thread: 't1',
  ...more,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-feedback-'));
  vi.resetModules();
  log = await import('../src/log');
  feedback = await import('../src/feedback');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('keeping the conversation with a verdict', () => {
  const turns = [
    { role: 'user' as const, content: 'what retries does the upload do?' },
    { role: 'assistant' as const, content: 'Three, doubling the wait.' },
    { role: 'user' as const, content: 'do the same for the download' },
  ];

  it('keeps the conversation, the workspace and the summary, which is what makes it replayable', () => {
    log.init(dir);
    feedback.record(verdict({ messages: turns, workspace: '/projects/demo', summary: 'Earlier: the uploader.' }));
    expect(lines()[0]).toMatchObject({
      messages: turns,
      workspace: '/projects/demo',
      summary: 'Earlier: the uploader.',
    });
  });

  it('keeps only what the classifier is shown, so the file holds what was rated and no more', () => {
    log.init(dir);
    const many = Array.from({ length: 9 }, (_, i) => ({ role: 'user' as const, content: `turn ${i}` }));
    feedback.record(verdict({ messages: [...many, { role: 'user', content: 'x'.repeat(900) }] }));
    const kept = lines()[0].messages as { content: string }[];
    // The last few only (RECENT_MESSAGES), each cut to length (MAX_MESSAGE_LENGTH)
    expect(kept).toHaveLength(4);
    expect(kept[0].content).toBe('turn 6');
    expect(kept.at(-1)!.content).toBe(`${'x'.repeat(600)} [...]`);
  });

  it('leaves them out altogether when the window did not send them', () => {
    log.init(dir);
    feedback.record(verdict());
    const line = lines()[0];
    expect(line.request).toBe('What is a closure?');
    expect('messages' in line).toBe(false);
    expect('workspace' in line).toBe(false);
    expect('summary' in line).toBe(false);
  });
});

describe('recording feedback', () => {
  it('keeps nothing until the log has been started', () => {
    feedback.record(verdict());
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes one line per verdict beside the log', () => {
    log.init(dir);
    feedback.record(verdict());
    feedback.record(verdict({ rating: 'bad', problems: ['too_high', 'wrong_type'] }));
    expect(lines()).toMatchObject([
      { rating: 'good', thread: 't1', request: 'What is a closure?', classification },
      { rating: 'bad', problems: ['too_high', 'wrong_type'] },
    ]);
    expect(lines()[0].problems).toBeUndefined();
    expect(typeof lines()[0].time).toBe('string');
  });

  it('keeps only the problems it knows, and only for a bad rating', () => {
    log.init(dir);
    feedback.record(verdict({ rating: 'bad', problems: ['too_low', 'nonsense' as never] }));
    feedback.record(verdict({ rating: 'good', problems: ['too_low'] }));
    expect(lines().map((line) => line.problems)).toEqual([['too_low'], undefined]);
  });
});
