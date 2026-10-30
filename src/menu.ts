// The app's own menu bar, in place of the one Electron puts up for an app
// that sets none.
//
// It is here for the Offline switch, which sits beside Quit: whether the app
// may talk to a model on somebody else's computer belongs with the things
// that are true of the whole app, not with one thread's model picker. The
// rest of the menu is the standard roles — an app that replaces the default
// menu has to put editing, zoom and window handling back itself, and on
// macOS a window with no Edit menu has no working Cmd+C.

import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
  // What the app calls itself, which names the menu it owns
  name: string;
  // Whether the app is keeping to this computer (see settings.ts)
  offline: boolean;
  // Whether there is a local model to keep to. Off, the switch is greyed out
  // and says why: a user with no local model who turns Offline on has taken
  // every model away from themselves and is given no reason for it. A switch
  // that is on is always left usable, whatever is available, so there is a way
  // back (see showMenu in main.ts).
  offlineEnabled: boolean;
  // The user has ticked or unticked Offline. What it ends up as is for the
  // caller to settle and to show (see showMenu in main.ts): a setting that
  // could not be saved must not leave a tick behind saying it was.
  onOffline(on: boolean): void;
  // Whether hosted models are preferred for their speed, and the same for
  // Fast: what it ends up as is the caller's to settle and to show
  fast: boolean;
  // Whether there is a hosted model to prefer, which wants a key (see
  // offlineEnabled)
  fastEnabled: boolean;
  onFast(on: boolean): void;
}

// The switch itself. Its tick is the only place the state is shown, so it is
// built from the setting every time the menu is.
function offlineItem({ offline, offlineEnabled, onOffline }: MenuOptions): MenuItemConstructorOptions {
  return {
    label: 'Offline',
    type: 'checkbox',
    checked: offline,
    enabled: offlineEnabled,
    accelerator: 'CmdOrCtrl+Shift+O',
    toolTip: offlineEnabled
      ? 'Use only the models on this computer'
      : 'Needs a model on this computer. Set Ollama up in Settings.',
    click: (item) => onOffline(item.checked),
  };
}

// Its neighbour, which prefers hosted models for the speed of them
function fastItem({ fast, fastEnabled, onFast }: MenuOptions): MenuItemConstructorOptions {
  return {
    label: 'Fast',
    type: 'checkbox',
    checked: fast,
    enabled: fastEnabled,
    accelerator: 'CmdOrCtrl+Shift+F',
    toolTip: fastEnabled
      ? 'Prefer hosted models, which answer faster'
      : 'Needs a hosted model. Add an API key in Settings.',
    click: (item) => onFast(item.checked),
  };
}

// The menus, in the order they appear. The one holding Quit holds the switch:
// on macOS that is the app's own menu, and elsewhere it is File.
export function template(options: MenuOptions, platform: string = process.platform): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  // The app's own name on the items that carry one. Unasked, macOS takes those
  // from the bundle the app is running out of, which for an app started with
  // `electron .` is Electron's own: the menu would say "About Electron" and
  // "Quit Electron" and read as the default menu rather than this one.
  const first: MenuItemConstructorOptions = mac
    ? {
        label: options.name,
        submenu: [
          { role: 'about', label: `About ${options.name}` },
          { type: 'separator' },
          offlineItem(options),
          fastItem(options),
          { type: 'separator' },
          { role: 'hide', label: `Hide ${options.name}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${options.name}` },
        ],
      }
    : {
        label: '&File',
        submenu: [offlineItem(options), fastItem(options), { type: 'separator' }, { role: 'quit', label: 'Exit' }],
      };
  return [first, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
}

// Puts the menu up, or puts it up again with the switch as it now stands
export function install(options: MenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template(options)));
}
