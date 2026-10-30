// Registry of the tools the decision loop can offer a model. A tool has a
// name the model calls it by, a description the model reads to decide when
// to use it, a JSON Schema for its input, and a run function (see Tool in
// ../types.ts).
//
// The sandbox tools (../sandbox) and the search tool (../search) are
// registered at startup.

import * as log from '../log';
import { splitToolReturn, type Tool, type ToolCall, type ToolContext, type ToolImage, type ToolVideo } from '../types';

const tools = new Map<string, Tool>();

export function register(tool: Tool): void {
  tools.set(tool.name, tool);
}

export function get(name: string): Tool | undefined {
  return tools.get(name);
}

export function list(): Tool[] {
  return [...tools.values()];
}

export function clear(): void {
  tools.clear();
}

// What a model is told when it calls a tool that does not exist. The names go
// with it: a model that reached for one of these invented it from the shape of
// the others — a coder asked for "bash_placeholder" where it had run_command —
// and the list is what settles it in one round rather than another guess.
export function noSuchTool(name: string, offered: Tool[]): string {
  return `There is no tool named "${name}". The tools you have are: ${offered
    .map((tool) => tool.name)
    .sort()
    .join(', ')}.`;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
  images?: ToolImage[];
  // Shown to the user under the reply and never sent to a model (see ToolVideo)
  videos?: ToolVideo[];
}

// Runs one call the model made and returns what to send back, whatever
// happened: a tool that throws reports its message as the result, since the
// model can often do something about it.
// where: what every log line about this call carries
export async function execute(call: ToolCall, context: ToolContext, where: log.Fields = {}): Promise<ToolResult> {
  const tool = get(call.name);
  const started = performance.now();
  let result: ToolResult;
  try {
    if (!tool) throw new Error(noSuchTool(call.name, list()));
    if (call.input === null) throw new Error('The tool input was not valid JSON.');
    const { text, images, videos } = splitToolReturn(await tool.run(call.input, context));
    result = {
      id: call.id,
      name: call.name,
      output: typeof text === 'string' ? text : JSON.stringify(text),
      isError: false,
      ...(images && { images }),
      ...(videos && { videos }),
    };
  } catch (err) {
    result = { id: call.id, name: call.name, output: (err as Error).message, isError: true };
  }

  const ms = log.since(started);
  const cancelled = context.signal.aborted;
  // A tool the user cut short didn't fail, so it isn't counted against it
  if (!cancelled) record(call.name, !result.isError, ms);
  const fields = { ...where, tool: call.name, ok: !result.isError, ms, outputChars: result.output.length };
  if (result.isError) log.warn('tool.call', { ...fields, cancelled, error: result.output });
  else log.info('tool.call', fields);
  return result;
}

// How a tool has done this session: how often it was called, how often it
// failed, and how long it took
export interface ToolStats {
  calls: number;
  failures: number;
  avgMs: number;
  maxMs: number;
}

const totals = new Map<string, { calls: number; failures: number; totalMs: number; maxMs: number }>();

export function record(name: string, ok: boolean, ms: number): void {
  const total = totals.get(name) ?? { calls: 0, failures: 0, totalMs: 0, maxMs: 0 };
  total.calls++;
  if (!ok) total.failures++;
  total.totalMs += ms;
  total.maxMs = Math.max(total.maxMs, ms);
  totals.set(name, total);
}

// Tool name -> its stats, for the tools called so far
export function stats(): Record<string, ToolStats> {
  const result: Record<string, ToolStats> = {};
  for (const [name, { calls, failures, totalMs, maxMs }] of totals) {
    result[name] = { calls, failures, avgMs: Math.round(totalMs / calls), maxMs };
  }
  return result;
}

export function resetStats(): void {
  totals.clear();
}
