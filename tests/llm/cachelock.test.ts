import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cachelock from '../../src/llm/cachelock';
import type { ChatMessage } from '../../src/types';

const { HOLD_MS, broke, held, holder, modelKey, shapeOf, brokeBy, waitFor } = cachelock;
const model = modelKey('local', 'qwen3.5:9b');
const other = modelKey('local', 'llama3.2:3b');
const now = 1_000_000;

beforeEach(() => {
  cachelock.forget();
  cachelock.whenFreed(() => {});
});

describe('which conversation a model is held for', () => {
  it('keeps it for the conversation it last answered, and makes another wait', () => {
    held(model, 'thread 1', now);
    expect(holder(model, now)).toBe('thread 1');
    expect(waitFor(model, 'thread 1', now)).toBe(0);
    expect(waitFor(model, 'thread 2', now)).toBe(HOLD_MS);
  });

  it('starts the hold again every time the conversation has the model', () => {
    held(model, 'thread 1', now);
    held(model, 'thread 1', now + 4000);
    expect(waitFor(model, 'thread 2', now + 4000)).toBe(HOLD_MS);
  });

  // A conversation that has stopped asking has stopped: waiting longer on it
  // leaves the model idle for want of anyone else being allowed to use it
  it('hands the model on once the hold has run out with nothing from it', () => {
    held(model, 'thread 1', now);
    expect(waitFor(model, 'thread 2', now + HOLD_MS - 1)).toBe(1);
    expect(waitFor(model, 'thread 2', now + HOLD_MS)).toBe(0);
    expect(holder(model, now + HOLD_MS)).toBeUndefined();
  });

  it('holds each model apart, since each has its own prompt in its own memory', () => {
    held(model, 'thread 1', now);
    held(other, 'thread 2', now);
    expect(waitFor(other, 'thread 2', now)).toBe(0);
    expect(waitFor(other, 'thread 1', now)).toBe(HOLD_MS);
    expect(waitFor(model, 'thread 1', now)).toBe(0);
  });

  // The app's own one-off prompts: classifying a message, compacting a record,
  // asking a subagent for a shorter report. None of them shares a prefix with
  // anything, so none of them has anything to wait for.
  it('never makes a request with no prompt of its own wait', () => {
    held(model, 'thread 1', now);
    expect(waitFor(model, undefined, now)).toBe(0);
  });

  it('ends the hold when one of them runs, the prefix being gone either way', () => {
    held(model, 'thread 1', now);
    held(model, undefined, now);
    expect(holder(model, now)).toBeUndefined();
    expect(waitFor(model, 'thread 2', now)).toBe(0);
  });
});

describe('giving a hold up', () => {
  it('gives up every model the conversation was holding', () => {
    held(model, 'thread 1', now);
    held(other, 'thread 1', now);
    broke('thread 1', 'reply over');
    expect(holder(model, now)).toBeUndefined();
    expect(holder(other, now)).toBeUndefined();
  });

  it('leaves what another conversation is holding alone', () => {
    held(model, 'thread 1', now);
    held(other, 'thread 2', now);
    broke('thread 1', 'reply over');
    expect(holder(other, now)).toBe('thread 2');
  });

  it('tells whatever is waiting, so that it starts rather than waiting the hold out', () => {
    const start = vi.fn();
    cachelock.whenFreed(start);
    held(model, 'thread 1', now);
    held(other, 'thread 1', now);
    broke('thread 1', 'handed work out');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('says nothing where the conversation was holding nothing', () => {
    const start = vi.fn();
    cachelock.whenFreed(start);
    held(model, 'thread 1', now);
    broke('thread 2', 'reply over');
    broke(undefined, 'reply over');
    expect(start).not.toHaveBeenCalled();
    expect(holder(model, now)).toBe('thread 1');
  });
});

describe('whether one step carries on from the last', () => {
  const user = (content: string): ChatMessage => ({ role: 'user', content });
  const sent = (system: string, tools: string[], messages: ChatMessage[] = [user('do the thing')]): cachelock.Shape =>
    shapeOf(
      system,
      tools.map((name) => ({ name })),
      messages
    );

  it('carries on where the instructions, the tools and the turns are the same', () => {
    const was = sent('instructions', ['read_file']);
    const now = sent('instructions', ['read_file']);
    expect(brokeBy(was, now)).toBeUndefined();
  });

  // What a step usually does: its own reply and the results of its calls go on
  // the end, and everything the server already read is still in front of it
  it('carries on where a reply and its results have been added', () => {
    const was = sent('instructions', ['read_file']);
    const now = sent(
      'instructions',
      ['read_file'],
      [
        user('do the thing'),
        { role: 'assistant', content: 'looking', toolCalls: [{ id: '1', name: 'read_file', input: {} }] },
        { role: 'tool', toolCallId: '1', name: 'read_file', content: '1: code' },
      ]
    );
    expect(brokeBy(was, now)).toBeUndefined();
  });

  it('does not where the tools changed, which costs the whole prompt', () => {
    expect(brokeBy(sent('instructions', ['read_file']), sent('instructions', ['write_file']))).toBe('tools changed');
    expect(brokeBy(sent('instructions', ['read_file']), sent('instructions', []))).toBe('tools changed');
  });

  it('does not where the instructions changed, as they do at a step boundary', () => {
    expect(brokeBy(sent('finding out', ['read_file']), sent('planning', ['read_file']))).toBe('instructions changed');
  });

  it('does not where a message has been pushed in among the ones already read', () => {
    const was = sent('instructions', ['read_file']);
    const now = sent(
      'instructions',
      ['read_file'],
      [user('do the thing'), { role: 'assistant', content: 'found it' }, user('Your rounds for finding out are spent.')]
    );
    expect(brokeBy(was, now)).toBe('message pushed in');
  });
});
