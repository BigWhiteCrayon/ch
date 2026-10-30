// Review comments: what the model is told about them and how they are read
// back out of the message the window wrote. The tool it replies with is
// defined in ../tools/review.ts.
//
// The user looks over what a thread changed (see the Changes
// pop-up in the renderer) and leaves comments on lines of it, as on a pull
// request. The comments are sent to the thread as a message, and the model
// acts on each one: it makes the change asked for, or answers the question,
// and then replies to the comment itself, so that the answer sits under the
// comment it answers.

// What the model is told when the message carries review comments
export const PROMPT = `The user has reviewed the changes you made in this thread and left comments on them. Each
comment has an id, like [c1], and names the file and the line it is about. Go through every comment. If it asks for a
change, make that change in the files. If it asks a question, work out the answer, reading the files if you need to;
do not change anything for a question unless it also asks you to. Then reply to each comment by calling
reply_to_comment with its id: say in a sentence or two what you changed, or give the answer to the question. Reply to
every comment, once each. Finish with a short summary for the user of what you did.`;

// What the model is told when reviewers have already been through the
// comments (see ../subagents): the work is done and replied to, and
// all that is left is to tell the user what happened.
export const SUMMARY_PROMPT = `The user's review comments have each been handled by a reviewer working in this
thread's container, and each has already been replied to under the comment it answers. Their reports are in the
conversation above. Do not go through the comments again, do not change anything they changed, and do not call
reply_to_comment: that has been done. Write the user a short summary of what was done across all of the comments, and
say plainly if a reviewer could not do what was asked.`;

// One comment as it was put to the thread, taken back out of the message the
// window wrote (see reviewMessage in renderer.ts, which is what this reads).
export interface Comment {
  // "c1", "c2", …
  id: string;
  // The whole of what was said about it: where it is, the line, and the
  // conversation under it so far
  body: string;
}

// The comments in a review message, one entry each. Nothing if the message
// isn't one, so a thread that is not reviewing is left alone.
export function comments(text: string): Comment[] {
  const found: Comment[] = [];
  // Each comment begins with its id at the start of a line
  const parts = text.split(/\n\n(?=\[c\d+\] )/);
  for (const part of parts) {
    const id = /^\[(c\d+)\] /.exec(part.trimStart())?.[1];
    if (id) found.push({ id, body: part.trim() });
  }
  return found;
}

// The same, for a model that can't call tools
export const PLAIN_PROMPT = `The user has reviewed changes made in this thread and left comments on them. Each
comment has an id, like [c1], and names the file and the line it is about. Answer every comment in your reply, under
its id: for a question, give the answer; for a requested change, show the change to make.`;
