// The right-click menu of a text box, which Electron does not draw unless it
// is asked to.
//
// Chromium already underlines a misspelt word as it is typed (the system
// dictionary on macOS and Windows, a downloaded one on Linux), but it leaves
// the correcting to the embedder: without this, the underline is all there is
// and not even Copy and Paste can be reached with the mouse. The suggestions
// are the spellchecker's own, handed over with the click, so no dictionary of
// ours is kept and none is shipped.

import { Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

// What the page says about the click, as far as the menu goes by it
export interface ContextParams {
  isEditable: boolean;
  selectionText: string;
  // The misspelt word under the click, if there is one
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean };
}

// How many corrections are offered above the rest
const SUGGESTIONS = 5;

// The menu for one click, or none where there is nothing to do: a click on
// the page's text offers Copy only when something is selected
export function template(params: ContextParams, contents: Pick<WebContents, 'replaceMisspelling' | 'session'>) {
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, SUGGESTIONS);
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (suggestions.length === 0) items.push({ label: 'No suggestions', enabled: false });
    items.push(
      { label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(word) },
      { type: 'separator' }
    );
  }
  const { editFlags } = params;
  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText) {
    items.push({ role: 'copy' });
  }
  return items;
}

// Puts the menu up wherever the window is clicked with the right button
export function attach(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const items = template(params, contents);
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
