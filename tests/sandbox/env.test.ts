import path from 'path';
import { describe, expect, it } from 'vitest';
import { toolEnv } from '../../src/sandbox/env';

describe('toolEnv', () => {
  it('appends the Homebrew directories to PATH on macOS and Linux', () => {
    const env = toolEnv({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux');
    expect(env.PATH).toBe(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter));
    expect(env.HOME).toBe('/home/me');
  });

  it("appends Docker Desktop's per-user directory on macOS", () => {
    const env = toolEnv({ PATH: '/usr/bin', HOME: '/Users/me' }, 'darwin');
    expect(env.PATH).toBe(
      ['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Users/me/.docker/bin'].join(path.delimiter)
    );
  });

  it('keeps existing PATH entries first so they take priority', () => {
    const env = toolEnv({ PATH: '/custom/bin' }, 'linux');
    expect(env.PATH?.split(path.delimiter)[0]).toBe('/custom/bin');
  });

  it('copes with no PATH at all', () => {
    const env = toolEnv({}, 'darwin');
    expect(env.PATH).toBe(['/opt/homebrew/bin', '/usr/local/bin'].join(path.delimiter));
  });

  it('leaves PATH alone on Windows', () => {
    expect(toolEnv({ PATH: 'C:\\bin' }, 'win32').PATH).toBe('C:\\bin');
  });

  it('does not modify the environment it was given', () => {
    const original = { PATH: '/usr/bin' };
    toolEnv(original, 'darwin');
    expect(original).toEqual({ PATH: '/usr/bin' });
  });
});
