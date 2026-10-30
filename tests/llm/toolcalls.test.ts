// Tool calls a model wrote into its message as text, turned back into calls
// (see ../../src/llm/toolcalls.ts). The case this is for was a local Qwen
// model writing <tool_call> markup into its reply: the provider saw no calls,
// the turn ended as an answer, and the edit it meant to make never happened.

import { describe, expect, it } from 'vitest';
import { parse, recover, value } from '../../src/llm/toolcalls';
import type { ChatEvent } from '../../src/types';

const OFFERED = new Set(['edit_file', 'search_workspace', 'read_file']);
const offered = (name: string) => OFFERED.has(name);

// The model's events, as a stream
async function* said(...events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const event of events) yield event;
}
const text = (delta: string): ChatEvent => ({ type: 'text', delta });
const done = (stopReason = 'stop'): ChatEvent => ({ type: 'done', stopReason, usage: { input: 10, output: 5 } });

const through = async (...events: ChatEvent[]) => {
  const out: ChatEvent[] = [];
  for await (const event of recover(said(...events), offered)) out.push(event);
  return out;
};
const saidText = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');
const calls = (events: ChatEvent[]) => events.filter((e) => e.type === 'tool_call') as (ChatEvent & { name: string })[];
const ending = (events: ChatEvent[]) => events.find((e) => e.type === 'done') as { stopReason: string } | undefined;

describe('what a parameter written as text means', () => {
  it('gives a tool the type it is expecting, since the markup has none', () => {
    expect(value('true')).toBe(true);
    expect(value('false')).toBe(false);
    expect(value('null')).toBeNull();
    expect(value('7')).toBe(7);
    expect(value('-2.5')).toBe(-2.5);
    expect(value('{"a":1}')).toEqual({ a: 1 });
    expect(value('[1,2]')).toEqual([1, 2]);
  });

  it('keeps everything else as the string it is, brackets and all', () => {
    expect(value('src/a.ts')).toBe('src/a.ts');
    expect(value('{not json')).toBe('{not json');
    expect(value('7 files')).toBe('7 files');
  });

  it('takes one line break either side as the markup’s, and the rest as the value’s', () => {
    expect(value('\nexport function a() {}\n')).toBe('export function a() {}');
    expect(value('\n\n  indented\n\n')).toBe('\n  indented\n');
  });
});

describe('reading one block', () => {
  it('reads the JSON form', () => {
    const block = '\n{"name": "edit_file", "arguments": {"path": "src/a.ts", "replace_all": true}}\n';
    expect(parse(block, offered)).toEqual({ name: 'edit_file', input: { path: 'src/a.ts', replace_all: true } });
  });

  it('reads the form spelled out in tags, which is how the failure in the log was written', () => {
    const block = `
<function=edit_file>
<parameter=path>src/search/embeddings.ts</parameter>
<parameter=old_text>
const hits = await rank(...)
</parameter>
<parameter=replace_all>false</parameter>
</function>
`;
    expect(parse(block, offered)).toEqual({
      name: 'edit_file',
      input: { path: 'src/search/embeddings.ts', old_text: 'const hits = await rank(...)', replace_all: false },
    });
  });

  it('keeps a value that is itself code, line breaks, fences and all', () => {
    const code = '```ts\nexport function a() {\n  return 1;\n}\n```';
    const found = parse(`<function=edit_file><parameter=content>\n${code}\n</parameter></function>`, offered);
    expect(found?.input.content).toBe(code);
  });

  it('takes arguments that are themselves a JSON string, as some models send them', () => {
    const block = '{"name": "read_file", "arguments": "{\\"path\\": \\"src/a.ts\\"}"}';
    expect(parse(block, offered)).toEqual({ name: 'read_file', input: { path: 'src/a.ts' } });
  });

  it.each([
    ['a tool that was never offered', '{"name": "deploy", "arguments": {}}'],
    ['a name that is not a name', '{"name": 7, "arguments": {}}'],
    ['arguments that cannot be read', '{"name": "read_file", "arguments": "{oops"}'],
    ['nothing that looks like a call', 'as I was saying, the <tool_call> tag is how models call tools'],
    ['an empty block', '  '],
  ])('refuses %s, so it stays the text it is', (_name, block) => {
    expect(parse(block, offered)).toBeNull();
  });
});

describe('a reply with no markup in it', () => {
  it('passes through exactly as it came, and is not made into a tool call', async () => {
    const events = await through(text('The parser is in '), text('src/parser.ts.'), done());
    expect(saidText(events)).toBe('The parser is in src/parser.ts.');
    expect(calls(events)).toEqual([]);
    expect(ending(events)?.stopReason).toBe('stop');
  });

  it('leaves the other events it carries alone, in the order they came', async () => {
    const events = await through(
      { type: 'queued' },
      { type: 'reasoning', delta: 'thinking' },
      text('Done.'),
      done('end_turn')
    );
    expect(events.map((e) => e.type)).toEqual(['queued', 'reasoning', 'text', 'done']);
  });
});

describe('a call the model wrote as text', () => {
  const block = '<tool_call>\n{"name": "search_workspace", "arguments": {"query": "toast"}}\n</tool_call>';

  it('becomes the call it was meant to be, and the turn becomes one that wants its tools run', async () => {
    const events = await through(text('I will look for it.\n'), text(block), done('stop'));
    expect(calls(events).map(({ name, input }) => [name, input])).toEqual([['search_workspace', { query: 'toast' }]]);
    // What the model wrote around it is still the reply; the markup is not
    expect(saidText(events)).toBe('I will look for it.\n');
    expect(ending(events)?.stopReason).toBe('tool_use');
  });

  it('is given an id of its own, as a real call has', async () => {
    const [call] = calls(await through(text(block), done()));
    expect((call as unknown as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is recovered however the markup is split across the stream', async () => {
    const events = await through(...[...block].map(text), done());
    expect(calls(events)).toHaveLength(1);
    expect(saidText(events)).toBe('');
  });

  it('never shows half a tag to the user while waiting for the rest of it', async () => {
    const out: string[] = [];
    for await (const event of recover(said(text('Looking: <tool_c'), text('all>{"name":"read_file"'), done()), offered))
      if (event.type === 'text') out.push(event.delta);
    // The first delta hands over only what cannot be part of a tag
    expect(out[0]).toBe('Looking: ');
    // ...and the unfinished block comes out as the text it turned out to be
    expect(out.join('')).toBe('Looking: <tool_call>{"name":"read_file"');
  });

  it('recovers several of them, in the order they were written', async () => {
    const two = `${block}\nand then\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>`;
    const events = await through(text(two), done());
    expect(calls(events).map(({ name }) => name)).toEqual(['search_workspace', 'read_file']);
    expect(saidText(events)).toBe('\nand then\n');
  });
});

describe('closing markup with nothing it closes', () => {
  // Word for word what the local model ended a reply with on 2026-10-08: the
  // edits it describes had really been made, by calls the provider did see,
  // and this litter was shown to the user as the end of the answer
  const REAL = `## Done: Modified \`search()\` to Block Until Index Loads

\`\`\`typescript
  const hits = await rank(...)
</parameter>
</function>
</tool_call>`;

  it('is dropped from the end of a reply, the answer before it kept whole', async () => {
    const events = await through(text(REAL), done());
    expect(saidText(events)).toBe(REAL.slice(0, REAL.indexOf('</parameter>')));
    expect(calls(events)).toEqual([]);
    // Nothing was recovered, so the turn ends as the answer it is
    expect(ending(events)?.stopReason).toBe('stop');
  });

  it('is dropped however the stream broke it up', async () => {
    const events = await through(...[...REAL].map(text), done());
    expect(saidText(events)).toBe(REAL.slice(0, REAL.indexOf('</parameter>')));
  });

  it('is kept where the model goes on afterwards, since then it meant it', async () => {
    const events = await through(text('About </function> tags'), text(': they close a call.'), done());
    expect(saidText(events)).toBe('About </function> tags: they close a call.');
  });

  it('is kept in the middle of an answer about this very markup', async () => {
    const said = 'A call ends with </parameter> then </function>, and the whole thing is wrapped in tool_call tags.';
    expect(saidText(await through(text(said), done()))).toBe(said);
  });

  it('leaves a reply that is nothing else all but empty, for the harness to ask about', async () => {
    // An empty turn is already asked about (see NO_ANSWER in ../../src/harness)
    const events = await through(text('\n</function>\n</tool_call>'), done());
    expect(saidText(events)).toBe('\n');
  });
});

describe('what it will not do', () => {
  it('leaves a block naming a tool nobody offered as text, so no phantom work starts', async () => {
    const quoted = '<tool_call>{"name": "deploy_to_production", "arguments": {}}</tool_call>';
    const events = await through(text('A call looks like '), text(quoted), done());
    expect(calls(events)).toEqual([]);
    expect(saidText(events)).toBe(`A call looks like ${quoted}`);
    expect(ending(events)?.stopReason).toBe('stop');
  });

  it('does not act on text when the model also made calls of its own, which say what it meant', async () => {
    const block = '<tool_call>{"name":"edit_file","arguments":{"path":"a.ts"}}</tool_call>';
    const events = await through(
      text('Editing.\n'),
      text(block),
      { type: 'tool_call', id: 'c1', name: 'edit_file', input: { path: 'b.ts' } },
      done('tool_use')
    );
    // The provider's own call, and no second one made out of the markup
    expect(calls(events).map((c) => (c as unknown as { id: string }).id)).toEqual(['c1']);
    // ...and nothing the model wrote is lost: the block is shown as written
    expect(saidText(events)).toBe(`Editing.\n${block}`);
  });

  it('leaves an unfinished block as text, rather than guessing what it would have said', async () => {
    const half = '<tool_call>{"name": "edit_file", "arguments": {"path": "src/a.ts"';
    const events = await through(text('Here goes: '), text(half), done());
    expect(calls(events)).toEqual([]);
    expect(saidText(events)).toBe(`Here goes: ${half}`);
  });

  it('recovers nothing from a reply that never finished, and keeps what it said', async () => {
    const out: ChatEvent[] = [];
    const block = '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
    for await (const event of recover(
      said(text(`stopped ${block}`), { type: 'error', code: 'other', message: 'x' }),
      offered
    ))
      out.push(event);
    expect(calls(out)).toEqual([]);
    expect(saidText(out)).toBe(`stopped ${block}`);
  });
});
