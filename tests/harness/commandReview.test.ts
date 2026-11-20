import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/types';

// The runner reads the opt-in from settings, runs a command-reviewer subagent
// through findings, and reads its verdict out of the subagent's reply. The
// subagent itself and the settings are stubbed, so a test asks the runner its
// three questions — does it run when the review is off, what does it say on an
// APPROVE, and what on a HOLD — without a model or a workspace.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  findings: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../src/settings', () => ({ get: mocks.get }));
vi.mock('../../src/log', () => ({ warn: mocks.warn, info: mocks.info, since: () => 0 }));
vi.mock('../../src/subagents', () => ({ findings: mocks.findings }));
// The kind the runner runs is a constant the runner only reads the name off; a
// stand-in is enough and keeps the real kind's prompt out of the test.
vi.mock('../../src/subagents/commandReviewer', () => ({ COMMAND_REVIEWER: { name: 'command-reviewer' } }));

import { parse, review } from '../../src/harness/commandReview';

const context = { signal: new AbortController().signal, threadId: 't1', workspace: '/w' } as ToolContext;
const input = {
  command: 'git reset --hard HEAD~3',
  path: '/repo',
  risk: '"--hard" overrides a check git makes, or drops something it is holding',
  intention: 'Revert the last three commits, I meant to throw them away.',
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.findings.mockReset();
  mocks.warn.mockReset();
  mocks.info.mockReset();
  mocks.get.mockReturnValue({ commandReview: true });
});

describe('parse', () => {
  it.each(['APPROVE', '  approve.\n', '**APPROVE**', '## Approve\nIt was within the request.', '`APPROVE`'])(
    'reads %j as an approval',
    (reply) => {
      expect(parse(reply)).toEqual({ approved: true, reason: '' });
    }
  );

  it('reads what follows HOLD as the reasons', () => {
    expect(parse('HOLD\n- it would drop uncommitted work\n- not within the request')).toEqual({
      approved: false,
      reason: '- it would drop uncommitted work\n- not within the request',
    });
    expect(parse('**Hold:**\n- Not within the request')).toEqual({
      approved: false,
      reason: '- Not within the request',
    });
  });

  it('reads the verdict a model reasoned its way to, rather than only its first line', () => {
    const reply = [
      'I checked the history and the uncommitted work.',
      '',
      'HOLD',
      '- the uncommitted work is not what the user asked to throw away.',
    ].join('\n');
    expect(parse(reply)).toEqual({
      approved: false,
      reason: '- the uncommitted work is not what the user asked to throw away.',
    });
    expect(parse('I read the repo and the command is within the request.\n\nAPPROVE')).toEqual({
      approved: true,
      reason: '',
    });
  });

  it('holds when HOLD names no reasons', () => {
    expect(parse('HOLD')).toEqual({ approved: false, reason: '' });
  });

  it.each(['', 'Looks fine to me', 'It is within the request'])('cannot read %j', (reply) => {
    expect(parse(reply)).toBeNull();
  });
});

describe('review', () => {
  it('does nothing when the review is off, and the gate asks the user as it always did', async () => {
    mocks.get.mockReturnValue({ commandReview: false });
    expect(await review({ ...input, context })).toBeNull();
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it('runs a reviewer, and reads its verdict from the reply', async () => {
    mocks.findings.mockResolvedValue([
      { name: 'command-review', task: '', text: '- checked history\nAPPROVE', isError: false },
    ]);
    expect(await review({ ...input, context })).toEqual({ approved: true, reason: '' });
    // The reviewer is told the request, the command and the folder, and the risk
    const [tasks] = mocks.findings.mock.calls[0];
    expect(tasks[0].task).toContain('Revert the last three commits');
    expect(tasks[0].task).toContain('git reset --hard HEAD~3 in /repo');
    expect(tasks[0].task).toContain('"--hard"');
  });

  it('comes back a hold with its reasons', async () => {
    mocks.findings.mockResolvedValue([
      { name: 'command-review', task: '', text: 'HOLD\n- not within the request', isError: false },
    ]);
    expect(await review({ ...input, context })).toEqual({ approved: false, reason: '- not within the request' });
  });

  it('returns null when the reviewer came back an error or no verdict', async () => {
    mocks.findings.mockResolvedValue([{ name: 'command-review', task: '', text: 'could not tell', isError: false }]);
    expect(await review({ ...input, context })).toBeNull();
    mocks.findings.mockResolvedValue([{ name: 'command-review', task: '', text: '', isError: true }]);
    expect(await review({ ...input, context })).toBeNull();
  });

  it('returns null when the run threw, so the gate falls through to the user', async () => {
    mocks.findings.mockRejectedValue(new Error('No model is available to run subagents.'));
    expect(await review({ ...input, context })).toBeNull();
    expect(mocks.warn).toHaveBeenCalled();
  });
});
