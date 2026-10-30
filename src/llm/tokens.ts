// Roughly how many tokens some text comes to. Nothing here counts tokens
// properly: that takes the model's own tokenizer, which only the server
// running it has. These are for the two jobs that cannot wait for a real
// count — deciding when a conversation is close to filling a window (see
// ../harness/compactor.ts), and showing a count climbing while a reply is
// still being written (see ../harness/index.ts, and llm/index.ts, which
// estimates for the providers that say nothing until the end).
//
// Wherever an estimate reaches the user it is marked as one, and it is never
// recorded: what a request used is what the provider said it used.
//
// The figures below were measured against anthropic's own count_tokens over
// 50 real prompts out of the app's log, 2,953 to 47,392 tokens, on 2026-10-28.

import type { ChatMessage, ToolImage } from '../types';

// Roughly how many characters a token comes to. Measured at 2.79 over 45 text
// prompts (p25 2.65, p50 2.77, p75 2.91, range 2.39 to 3.30): a conversation
// is mostly code, paths and tool-result JSON, which tokenize far worse than
// prose. It was 3.5, which undercounted every one of those prompts — by 20% on
// average and 32% at worst, so a window reported seven tenths full was really
// closer to nine tenths. At 2.8 the same prompts come out 0.4% low on average,
// between 14% low and 18% high. The spread is the content's, not the
// constant's: no single figure does better than about fifteen percent either
// way, which is why the compactor keeps a margin on top of this (see MARGIN in
// ../harness/compactor.ts).
export const CHARS_PER_TOKEN = 2.8;

export const estimate = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

// Images are not counted in characters at all. A model reads one in patches of
// 28×28 pixels, one token each, so what an image costs is its dimensions and
// nothing else — the bytes say nothing of it, and a flat figure per image is
// wrong by whatever the picture happens to be. Measured against count_tokens
// on all 15 images the app has sent: ⌈width/28⌉ × ⌈height/28⌉ plus BLOCK, to
// the token, every time (anthropic's vision docs, 2026-10-28).
const PATCH = 28;
// What the image block itself comes to, around the picture
const BLOCK = 3;
// An image too large for the model is scaled down, keeping its shape, to the
// largest size that fits both of these: no side longer than MAX_EDGE, and no
// more than MAX_PATCHES patches. These are the limits of the high-resolution
// tier, which is every model from Claude 4.7 on and so every hosted model this
// app talks to; a model on the older tier stops at 1,568 of each, and an image
// large enough for the difference to matter is rare in a tool result.
const MAX_EDGE = 2576;
const MAX_PATCHES = 4784;
// What an image whose dimensions cannot be read is taken to cost: a screenshot
// at the size the tools take them (1280×800, see SHOT_WIDTH in
// ../tools/sandbox.ts), which is what nearly every image here is.
export const IMAGE_TOKENS = 1337;

const patches = (width: number, height: number): number => Math.ceil(width / PATCH) * Math.ceil(height / PATCH);

// Python's round(), which the resizing follows: an exact half goes to the even
// side rather than upwards, and the two disagree about some images.
function roundTiesToEven(value: number): number {
  const down = Math.floor(value);
  if (value - down !== 0.5) return Math.round(value);
  return down % 2 === 0 ? down : down + 1;
}

// The size an image is scaled to before it is read, or the size it already is.
// This is anthropic's own rule, binary search and all (see "How Claude resizes
// and pads images"); the padding it then adds is not charged for.
function fitted(width: number, height: number): [number, number] {
  const fits = (w: number, h: number): boolean =>
    Math.ceil(w / PATCH) * PATCH <= MAX_EDGE &&
    Math.ceil(h / PATCH) * PATCH <= MAX_EDGE &&
    patches(w, h) <= MAX_PATCHES;
  if (fits(width, height)) return [width, height];
  // The long edge is the one searched over, so a tall image is turned around
  if (height > width) {
    const [h, w] = fitted(height, width);
    return [w, h];
  }
  const aspect = width / height;
  const short = (long: number) => Math.max(roundTiesToEven(long / aspect), 1);
  let lo = 1; // always fits
  let hi = width; // never fits
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, short(mid))) lo = mid;
    else hi = mid;
  }
  return [lo, short(lo)];
}

// The pixel dimensions in an image's own first bytes, or null for an image
// this cannot read. Only the header is decoded, not the picture: a screenshot
// is a megabyte of base64 and this runs on every message of every estimate.
export function pixels({ mediaType, data }: ToolImage): { width: number; height: number } | null {
  // Enough for a PNG's IHDR, which is first, and for the frame header of a
  // JPEG that carries a large thumbnail or colour profile ahead of it
  const head = Buffer.from(data.slice(0, 90_000), 'base64');
  if (mediaType === 'image/png') {
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    if (head.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (mediaType === 'image/jpeg') {
    if (head.length < 4 || head.readUInt16BE(0) !== 0xffd8) return null;
    // Segment by segment to the frame header, which is where the size is
    for (let at = 2; at + 9 < head.length;) {
      if (head[at] !== 0xff) {
        at++;
        continue;
      }
      const marker = head[at + 1];
      // The markers that carry no length: padding, start of image, restarts
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      // A frame header (SOF0 to SOF15), less the three markers in that range
      // that are something else: tables, and the two restart definitions
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: head.readUInt16BE(at + 5), width: head.readUInt16BE(at + 7) };
      }
      at += 2 + head.readUInt16BE(at + 2);
    }
  }
  return null;
}

// What one image comes to, from its own dimensions
export function imageTokens(image: ToolImage): number {
  const size = pixels(image);
  if (!size || !size.width || !size.height) return IMAGE_TOKENS;
  const [width, height] = fitted(size.width, size.height);
  return patches(width, height) + BLOCK;
}

// ...and what a prompt comes to: the messages as the model will see them,
// with the tool calls written into them, since a tool loop's prompt is mostly
// results and the calls they answer, and the images a result carries.
export function sizeOf(messages: ChatMessage[], system = ''): number {
  let chars = system.length;
  // The images are counted in tokens from the start, having no characters
  let images = 0;
  for (const m of messages) {
    chars += m.content.length;
    if ('toolCalls' in m && m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    if ('images' in m && m.images) for (const image of m.images) images += imageTokens(image);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images;
}
