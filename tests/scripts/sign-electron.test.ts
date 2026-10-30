import { describe, expect, it } from 'vitest';
import { APP, isSealed, main, type System } from '../../src/scripts/sign-electron';

// What `codesign -dv` says about a bundle, in the two states that matter
const UNSIGNED = `Executable=${APP}/Contents/MacOS/Electron
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Signature=adhoc
Info.plist=not bound
Sealed Resources=none
`;
const SIGNED = `Executable=${APP}/Contents/MacOS/Electron
CodeDirectory v=20400 size=492 flags=0x2(adhoc) hashes=9+3 location=embedded
Signature=adhoc
Info.plist entries=31
Sealed Resources version=2 rules=13 files=10
`;

// A stand-in for the machine: what codesign reports, and whether it works
function fakeSystem(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  files?: string[];
  reports?: string;
  signs?: boolean;
}) {
  const ran: string[] = [];
  const logs: string[] = [];
  const system: System = {
    platform: options.platform ?? 'darwin',
    env: options.env ?? {},
    dryRun: options.dryRun ?? false,
    exists: (file) => (options.files ?? [APP]).includes(file),
    run: (command, args) => {
      ran.push([command, ...args].join(' '));
      return options.signs ?? true;
    },
    read: () => options.reports ?? UNSIGNED,
    log: (message) => logs.push(message),
  };
  return { system, ran, logs };
}

describe('isSealed', () => {
  it('reads a bundle Electron shipped as unsigned', () => {
    expect(isSealed(fakeSystem({ reports: UNSIGNED }).system)).toBe(false);
  });

  it('reads one that has been signed', () => {
    expect(isSealed(fakeSystem({ reports: SIGNED }).system)).toBe(true);
  });

  it('takes a bundle codesign cannot read at all as unsigned', () => {
    expect(isSealed(fakeSystem({ reports: '' }).system)).toBe(false);
  });
});

describe('main', () => {
  it('signs the Electron that macOS would otherwise refuse notifications from', () => {
    const { system, ran, logs } = fakeSystem({});
    main(system);
    expect(ran).toEqual([`codesign --force --deep --sign - ${APP}`]);
    expect(logs.join('\n')).toContain('notifications');
  });

  it('leaves an Electron that is already signed alone', () => {
    const { system, ran } = fakeSystem({ reports: SIGNED });
    main(system);
    expect(ran).toEqual([]);
  });

  it('does nothing off macOS, whose notifications ask nothing of the signature', () => {
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      const { system, ran, logs } = fakeSystem({ platform });
      main(system);
      expect(ran).toEqual([]);
      expect(logs).toEqual([]);
    }
  });

  it('says so, rather than failing, when there is no Electron installed', () => {
    const { system, ran, logs } = fakeSystem({ files: [] });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.join('\n')).toContain('nothing to sign');
  });

  it('can be told to skip', () => {
    const { system, ran } = fakeSystem({ env: { CH_SKIP_ELECTRON_SIGN: '1' } });
    main(system);
    expect(ran).toEqual([]);
  });

  it('only says what it would do on a dry run', () => {
    const { system, ran, logs } = fakeSystem({ dryRun: true });
    main(system);
    expect(ran).toEqual([]);
    expect(logs.join('\n')).toContain('would run: codesign');
  });

  it('reports a signing that failed without failing the install', () => {
    const { system, logs } = fakeSystem({ signs: false });
    expect(() => main(system)).not.toThrow();
    expect(logs.join('\n')).toContain('npm run sign-electron');
  });
});
