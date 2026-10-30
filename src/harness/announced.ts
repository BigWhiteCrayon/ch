// Reading a turn that said what the model was about to do, and then ended.
//
// A model that writes "I need to find where this is implemented" and stops has
// not answered and has not acted: the turn made no tool call, so nothing
// happened, and whoever was waiting has the sentence and none of the work. It
// happens to a reply (see ./index.ts) and to a subagent (see
// ../subagents/run.ts), and both have to tell such a turn from a real one
// before they take it as the end of the work, so the reading of it lives here
// rather than in either of them.

// The longest turn that can be an announcement rather than an answer. An
// answer of any substance is longer than this; the ones this is for are a
// sentence (see announcing).
const ANNOUNCEMENT_LENGTH = 800;

// Saying it is about to look at something, which the model does in place of
// looking: "I need to find where toast notifications are implemented", and
// then the turn ends.
//
// Deliberately narrow. It has to match an intention to use a tool and not an
// answer that happens to mention looking — "I checked where they are
// implemented" is a report, not an announcement, and must not set the model
// off again.
// Somebody about to act...
const INTENDS = [`I(?:'| wi)ll`, 'I am going to', `I'm going to`, 'I need to', 'I have to', 'I should', 'I must']
  .concat(['Let me', 'First,? I'])
  .join('|');
// ...and the looking they are about to do, within the same sentence
const LOOKS = ['search', 'look', 'find', 'check', 'read', 'examine', 'inspect', 'explore']
  .concat(['review', 'investigate', 'locate', 'see where'])
  .join('|');
const ANNOUNCEMENT = new RegExp(String.raw`\b(?:${INTENDS})\b[^.!?]{0,80}\b(?:${LOOKS})\b`, 'i');

export function announcing(text: string): boolean {
  const said = text.trim();
  return said.length > 0 && said.length <= ANNOUNCEMENT_LENGTH && ANNOUNCEMENT.test(said);
}
