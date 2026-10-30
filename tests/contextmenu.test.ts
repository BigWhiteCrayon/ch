import { beforeEach, describe, expect, it, vi } from 'vitest';

// Electron's menu, replaced so that what was put up can be read back
const electron = vi.hoisted(() => ({ built: [] as any[][], popup: vi.fn() }));
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: any[]) => {
      electron.built.push(template);
      return { popup: electron.popup };
    },
  },
}));

import { attach, template, type ContextParams } from '../src/contextmenu';

const replaceMisspelling = vi.fn();
const addWord = vi.fn();
const contents = { replaceMisspelling, session: { addWordToSpellCheckerDictionary: addWord } } as any;

const params = (patch: Partial<ContextParams> = {}): ContextParams => ({
  isEditable: true,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true },
  ...patch,
});
const names = (items: any[]) => items.map((item) => item.label ?? item.role ?? item.type);

beforeEach(() => {
  vi.clearAllMocks();
  electron.built.length = 0;
});

describe('template', () => {
  it('offers the spellchecker corrections above the editing items', () => {
    const items = template(params({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'] }), contents);
    expect(names(items).slice(0, 4)).toEqual(['the', 'tea', 'Add to Dictionary', 'separator']);
    items[0].click!({} as any, undefined, {} as any);
    expect(replaceMisspelling).toHaveBeenCalledWith('the');
    expect(names(items)).toContain('paste');
  });

  it('adds the word to the dictionary', () => {
    const items = template(params({ misspelledWord: 'ch', dictionarySuggestions: [] }), contents);
    expect(names(items).slice(0, 2)).toEqual(['No suggestions', 'Add to Dictionary']);
    items[1].click!({} as any, undefined, {} as any);
    expect(addWord).toHaveBeenCalledWith('ch');
  });

  it('offers no more than five corrections', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const items = template(params({ misspelledWord: 'x', dictionarySuggestions: many }), contents);
    expect(names(items).slice(0, 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'Add to Dictionary']);
  });

  it('leaves out corrections where no word is misspelt', () => {
    const items = template(params(), contents);
    expect(names(items)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(items.find((item) => item.role === 'paste')!.enabled).toBe(true);
    expect(items.find((item) => item.role === 'cut')!.enabled).toBe(false);
  });

  it('offers Copy only for selected text outside a text box', () => {
    expect(template(params({ isEditable: false }), contents)).toEqual([]);
    expect(names(template(params({ isEditable: false, selectionText: 'x' }), contents))).toEqual(['copy']);
  });
});

describe('attach', () => {
  const listen = (): ((event: unknown, params: ContextParams) => void) => {
    const on = vi.fn();
    attach({ ...contents, on } as any);
    return on.mock.calls.find(([name]) => name === 'context-menu')![1];
  };

  it('puts the menu up on a right-click', () => {
    listen()({}, params());
    expect(electron.built).toHaveLength(1);
    expect(electron.popup).toHaveBeenCalledTimes(1);
  });

  it('puts up nothing where there is nothing to offer', () => {
    listen()({}, params({ isEditable: false }));
    expect(electron.popup).not.toHaveBeenCalled();
  });
});
