import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

// Electron's menu, replaced so that what was put up can be read back
const electron = vi.hoisted(() => ({ built: [] as unknown[], set: [] as unknown[] }));
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => {
      electron.built.push(template);
      return { template };
    },
    setApplicationMenu: (menu: unknown) => electron.set.push(menu),
  },
}));

import { install, template } from '../src/menu';

const onOffline = vi.fn();
const onFast = vi.fn();
// Both switches usable unless a test says otherwise: whether there is
// anything to switch between is settled by the caller (see showMenu in main.ts)
const options = (offline = false, fast = false, enabled = true) => ({
  name: 'ch',
  offline,
  offlineEnabled: enabled,
  onOffline,
  fast,
  fastEnabled: enabled,
  onFast,
});

// The menu that holds Quit, which is where the switch belongs
const first = (platform: string, offline = false) => template(options(offline), platform)[0];
const items = (platform: string, offline = false) =>
  (first(platform, offline).submenu as MenuItemConstructorOptions[]) ?? [];
const labels = (platform: string) => items(platform).map((item) => item.label ?? item.role ?? item.type);
const offlineItem = (platform: string, offline = false) =>
  items(platform, offline).find((item) => item.label === 'Offline')!;

beforeEach(() => {
  electron.built = [];
  electron.set = [];
  onOffline.mockReset();
});

describe('the menu', () => {
  it('puts the app itself first on macOS, and File elsewhere', () => {
    expect(first('darwin').label).toBe('ch');
    expect(first('win32').label).toBe('&File');
  });

  it('keeps editing, viewing and windows, which an app that sets a menu has to put back', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(template(options(), platform).map((menu) => menu.role)).toEqual([
        undefined,
        'editMenu',
        'viewMenu',
        'windowMenu',
      ]);
    }
  });

  it('has the switch in the same menu as Quit, on either sort of computer', () => {
    expect(labels('darwin')).toEqual([
      'About ch',
      'separator',
      'Offline',
      'Fast',
      'separator',
      'Hide ch',
      'hideOthers',
      'unhide',
      'separator',
      'Quit ch',
    ]);
    // Where that menu is File, it holds the two of them and nothing else
    expect(labels('win32')).toEqual(['Offline', 'Fast', 'separator', 'Exit']);
  });

  it('puts the app’s own name on the items that carry one, which macOS otherwise takes from the bundle', () => {
    const named = items('darwin').filter((item) => typeof item.label === 'string' && item.label.includes('ch'));
    expect(named.map((item) => item.role)).toEqual(['about', 'hide', 'quit']);
    expect(labels('win32')).not.toContain('About ch');
  });

  it('is a tick, and the tick is the setting', () => {
    expect(offlineItem('darwin')).toMatchObject({ type: 'checkbox', checked: false });
    expect(offlineItem('darwin', true).checked).toBe(true);
    expect(offlineItem('win32', true).checked).toBe(true);
  });

  it('can be thrown from the keyboard, and says what it does', () => {
    expect(offlineItem('darwin').accelerator).toBe('CmdOrCtrl+Shift+O');
    expect(offlineItem('darwin').toolTip).toContain('only the models on this computer');
  });

  // A switch with nothing to switch between: greyed out, and saying what it
  // would take rather than only that it may not be used
  it('is greyed out when there is nothing to switch between, and says what is missing', () => {
    const switches = (template(options(false, false, false), 'darwin')[0].submenu as MenuItemConstructorOptions[])
      .filter((item) => item.type === 'checkbox')
      .map(({ label, enabled, toolTip }) => `${label}: ${enabled} ${toolTip}`);
    expect(switches).toEqual([
      'Offline: false Needs a model on this computer. Set Ollama up in Settings.',
      'Fast: false Needs a hosted model. Add an API key in Settings.',
    ]);
    expect(offlineItem('darwin').enabled).toBe(true);
  });

  it('passes on what it was ticked to, not what it was', () => {
    const clicked = (checked: boolean) =>
      offlineItem('darwin').click?.({ checked } as never, undefined as never, undefined as never);
    clicked(true);
    expect(onOffline).toHaveBeenLastCalledWith(true);
    clicked(false);
    expect(onOffline).toHaveBeenLastCalledWith(false);
  });

  it('has Fast beside it, ticked as the setting says, and passes on what it was ticked to', () => {
    const fastItem = (fast: boolean) =>
      (template(options(false, fast), 'darwin')[0].submenu as MenuItemConstructorOptions[]).find(
        (item) => item.label === 'Fast'
      )!;
    expect(fastItem(false)).toMatchObject({ type: 'checkbox', checked: false, accelerator: 'CmdOrCtrl+Shift+F' });
    expect(fastItem(true).checked).toBe(true);
    fastItem(true).click?.({ checked: false } as never, undefined as never, undefined as never);
    expect(onFast).toHaveBeenLastCalledWith(false);
  });

  it('puts itself up, and puts itself up again with the switch as it now stands', () => {
    install(options(false));
    install(options(true));
    expect(electron.set).toHaveLength(2);
    expect(electron.built).toHaveLength(2);
    const ticked = (built: unknown) => {
      const menus = built as MenuItemConstructorOptions[];
      const own = menus[0].submenu as MenuItemConstructorOptions[];
      return own.find((item) => item.label === 'Offline')?.checked;
    };
    expect(electron.built.map(ticked)).toEqual([false, true]);
  });
});
