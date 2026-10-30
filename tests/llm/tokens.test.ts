import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, IMAGE_TOKENS, estimate, imageTokens, pixels, sizeOf } from '../../src/llm/tokens';
import type { ChatMessage, ToolImage } from '../../src/types';

// A PNG of the given dimensions: the signature and an IHDR, which is all
// anything here reads of an image
function png(width: number, height: number): ToolImage {
  const head = Buffer.alloc(24);
  head.writeUInt32BE(0x89504e47, 0);
  head.writeUInt32BE(0x0d0a1a0a, 4);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return { mediaType: 'image/png', data: head.toString('base64') };
}

// ...and a JPEG, whose size is in a frame header some way in. `ahead` puts a
// segment in front of it, as a thumbnail or a colour profile does.
function jpeg(width: number, height: number, ahead = 0): ToolImage {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (ahead) {
    const app = Buffer.alloc(4 + ahead);
    app.writeUInt16BE(0xffe1, 0);
    app.writeUInt16BE(ahead + 2, 2);
    parts.push(app);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return { mediaType: 'image/jpeg', data: Buffer.concat(parts).toString('base64') };
}

describe('estimate', () => {
  it('counts characters at the measured rate', () => {
    expect(CHARS_PER_TOKEN).toBe(2.8);
    expect(estimate('')).toBe(0);
    expect(estimate('a'.repeat(28))).toBe(10);
  });
});

describe('pixels', () => {
  it('reads a PNG’s dimensions out of its header', () => {
    expect(pixels(png(1280, 800))).toEqual({ width: 1280, height: 800 });
  });

  it('reads a JPEG’s dimensions out of its frame header, whatever is in front of it', () => {
    expect(pixels(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pixels(jpeg(640, 480, 20_000))).toEqual({ width: 640, height: 480 });
  });

  it('is null for an image it cannot read', () => {
    expect(pixels({ mediaType: 'image/png', data: '' })).toBeNull();
    expect(pixels({ mediaType: 'image/png', data: Buffer.from('not a png at all').toString('base64') })).toBeNull();
    expect(pixels({ mediaType: 'image/jpeg', data: Buffer.from('nor this').toString('base64') })).toBeNull();
  });
});

describe('imageTokens', () => {
  // The figures anthropic's count_tokens gave for the images this app has
  // actually sent (2026-10-28). They are what the model is charged for, and
  // each is the patch count plus the three tokens of the block around it.
  it('matches what the images the app sends really cost', () => {
    expect(imageTokens(png(1280, 800))).toBe(1337); // the default screenshot
    expect(imageTokens(png(1000, 900))).toBe(1191);
    expect(imageTokens(png(1000, 400))).toBe(543);
    expect(imageTokens(png(480, 900))).toBe(597);
  });

  it('counts a patch of 28×28 pixels, part of one included', () => {
    expect(imageTokens(png(28, 28))).toBe(1 + 3);
    expect(imageTokens(png(29, 28))).toBe(2 + 3);
    expect(imageTokens(png(1, 1))).toBe(1 + 3);
  });

  // The sizes anthropic's vision docs give a token cost for, which is the
  // check on the scaling: the first three are small enough to be read as they
  // are, and the last is scaled to 2576x1449 to fit the token limit.
  it('scales an image too large for the model, as the published examples do', () => {
    expect(imageTokens(png(1000, 1000))).toBe(1296 + 3);
    expect(imageTokens(png(1092, 1092))).toBe(1521 + 3);
    expect(imageTokens(png(1920, 1080))).toBe(2691 + 3);
    expect(imageTokens(png(3840, 2160))).toBe(4784 + 3);
  });

  it('keeps a long thin image inside the edge limit', () => {
    // 8000 is the largest side the API takes at all
    expect(imageTokens(png(8000, 200))).toBeLessThanOrEqual(4784 + 3);
    expect(imageTokens(png(200, 8000))).toBeLessThanOrEqual(4784 + 3);
    // Turning it on its side costs the same
    expect(imageTokens(png(8000, 200))).toBe(imageTokens(png(200, 8000)));
  });

  it('falls back to a screenshot’s worth for an image it cannot read', () => {
    expect(imageTokens({ mediaType: 'image/png', data: 'nonsense' })).toBe(IMAGE_TOKENS);
    expect(imageTokens(png(0, 0))).toBe(IMAGE_TOKENS);
  });
});

describe('sizeOf', () => {
  const user = (content: string): ChatMessage => ({ role: 'user', content });

  it('counts the system prompt with the messages', () => {
    expect(sizeOf([user('a'.repeat(28))], 'b'.repeat(28))).toBe(20);
  });

  it('counts the tool calls written into a message', () => {
    const call: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'src/main.ts' } }],
    };
    expect(sizeOf([call])).toBeGreaterThan(sizeOf([user('')]));
  });

  it('counts a result’s images by their dimensions rather than by the count of them', () => {
    const result = (images: ToolImage[]): ChatMessage => ({
      role: 'tool',
      toolCallId: '1',
      name: 'screenshot',
      content: '',
      isError: false,
      images,
    });
    expect(sizeOf([result([png(1280, 800)])])).toBe(1337);
    expect(sizeOf([result([png(1280, 800), png(480, 900)])])).toBe(1337 + 597);
    // Two images of the same count are not the same size
    expect(sizeOf([result([png(1000, 900)])])).not.toBe(sizeOf([result([png(480, 900)])]));
  });
});
