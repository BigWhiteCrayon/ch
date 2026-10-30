// Markdown, for the model's replies. Built straight into DOM nodes rather
// than through HTML text, so nothing a model writes can become markup or
// script. Covers what models commonly produce: headings, paragraphs, lists
// (nested too), code blocks, quotes, tables, rules, and inline code, bold,
// italics, strikethrough and links. Anything else is shown as written.

import { renderDiagram } from './diagram.js';

export const MD_ESCAPE = String.raw`\\([\\\x60*_{}\[\]()#+\-.!~|>])`;
export const MD_CODE = String.raw`(\x60+)([\s\S]+?)\2`;
export const MD_LINK = String.raw`\[([^\]\n]+)\]\(([^)\s]+)\)`;
export const MD_BOLD = String.raw`\*\*([\s\S]+?)\*\*|__([\s\S]+?)__`;
export const MD_STRIKE = String.raw`~~([\s\S]+?)~~`;
// A lone * or _ only counts when it hugs the text; _ also not inside a word
export const MD_ITALIC = String.raw`\*([^*\s](?:[\s\S]*?[^*\s])?)\*|(?<!\w)_([^_\s](?:[\s\S]*?[^_\s])?)_(?!\w)`;
export const MD_URL = String.raw`(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])`;
export const MD_INLINE = [MD_ESCAPE, MD_CODE, MD_LINK, MD_BOLD, MD_STRIKE, MD_ITALIC, MD_URL].join('|');

export const MD_FENCE = /^(\s*)(\x60{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
export const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
export const MD_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
export const MD_QUOTE = /^\s{0,3}>\s?/;
export const MD_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
export const MD_TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// Links may only lead out to the web or to an email address
export const mdSafeLink = (url: string) => /^(https?:|mailto:)/i.test(url);

export function mdLink(url: string, content: Node[]): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = url;
  // Opened in the user's browser by the main process, never in this window
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.append(...content);
  return a;
}

// Plain text, with its line breaks kept
export function mdText(text: string): Node[] {
  return text
    .split('\n')
    .flatMap((line, i) => (i ? [document.createElement('br'), line] : [line]))
    .filter((part) => part !== '')
    .map((part) => (typeof part === 'string' ? document.createTextNode(part) : part));
}

export function mdInline(text: string): Node[] {
  const nodes: Node[] = [];
  const pattern = new RegExp(MD_INLINE, 'g');
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    nodes.push(...mdText(text.slice(last, m.index)));
    last = pattern.lastIndex;
    const [whole, escaped, , code, linkText, linkUrl, bold1, bold2, strike, italic1, italic2, url] = m;
    const wrap = (tag: string, inner: string) => {
      const el = document.createElement(tag);
      el.append(...mdInline(inner));
      return el;
    };
    if (escaped !== undefined) {
      nodes.push(document.createTextNode(escaped));
    } else if (code !== undefined) {
      const el = document.createElement('code');
      el.textContent = code.trim() || code;
      nodes.push(el);
    } else if (linkUrl !== undefined) {
      if (mdSafeLink(linkUrl)) nodes.push(mdLink(linkUrl, mdInline(linkText)));
      else nodes.push(document.createTextNode(whole));
    } else if (bold1 !== undefined || bold2 !== undefined) {
      nodes.push(wrap('strong', bold1 ?? bold2));
    } else if (strike !== undefined) {
      nodes.push(wrap('del', strike));
    } else if (italic1 !== undefined || italic2 !== undefined) {
      nodes.push(wrap('em', italic1 ?? italic2));
    } else {
      nodes.push(mdLink(url, [document.createTextNode(url)]));
    }
  }
  nodes.push(...mdText(text.slice(last)));
  return nodes;
}

export const mdIndent = (line: string) => (/^\s*/.exec(line) as RegExpExecArray)[0].length;

// A fenced code block starting at lines[start]; returns the line after it.
// A fence the model hasn't closed yet (mid-stream) runs to the end.
export function mdCodeBlock(lines: string[], start: number, out: Node): number {
  const [, indent, fence, language] = MD_FENCE.exec(lines[start]) as RegExpExecArray;
  const body: string[] = [];
  let closed = false;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const closing = MD_FENCE.exec(lines[i]);
    if (closing && closing[2][0] === fence[0] && closing[2].length >= fence.length && !closing[3]) {
      closed = true;
      i++;
      break;
    }
    // Code under a list item is indented along with its fence
    body.push(lines[i].slice(Math.min(indent.length, mdIndent(lines[i]))));
  }
  // A diagram is drawn once it is all there; until then, and if it can't be read, it is shown as code
  const diagram = closed && language.toLowerCase() === 'mermaid' ? renderDiagram(body.join('\n')) : null;
  if (diagram) {
    out.appendChild(diagram);
    return i;
  }
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (language) code.dataset.language = language;
  code.textContent = body.join('\n');
  pre.append(code);
  out.appendChild(pre);
  return i;
}

// A list starting at lines[start]; returns the line after it. More deeply
// indented items become lists inside the item above them.
export function mdList(lines: string[], start: number, out: Node): number {
  const first = MD_ITEM.exec(lines[start]) as RegExpExecArray;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) (list as HTMLOListElement).start = parseInt(first[2], 10);
  let item: HTMLLIElement | null = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = MD_ITEM.exec(line);
    if (m && m[1].length < base) break;
    if (m && m[1].length <= base + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      item = document.createElement('li');
      item.append(...mdInline(m[3]));
      list.append(item);
      i++;
    } else if (m && item) {
      i = mdList(lines, i, item);
    } else if (!line.trim()) {
      // A blank line ends the list unless the list carries on after it
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      const after = lines[next];
      if (after === undefined || mdIndent(after) < base) break;
      if (!MD_ITEM.test(after) && mdIndent(after) <= base) break;
      i = next;
    } else if (item && mdIndent(line) > base && MD_FENCE.test(line)) {
      i = mdCodeBlock(lines, i, item);
    } else if (item && mdIndent(line) > base) {
      item.append(document.createElement('br'), ...mdInline(line.trim()));
      i++;
    } else {
      break;
    }
  }
  out.appendChild(list);
  return i;
}

export const mdCells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

// A table starting at lines[start] (its header row); returns the line after it
export function mdTable(lines: string[], start: number, out: Node): number {
  const aligns = mdCells(lines[start + 1]).map((rule) =>
    rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : ''
  );
  const table = document.createElement('table');
  const row = (cells: string[], tag: 'th' | 'td') => {
    const tr = document.createElement('tr');
    cells.forEach((text, column) => {
      const cell = document.createElement(tag);
      if (aligns[column]) cell.style.textAlign = aligns[column];
      cell.append(...mdInline(text));
      tr.append(cell);
    });
    return tr;
  };
  const head = document.createElement('thead');
  head.append(row(mdCells(lines[start]), 'th'));
  const body = document.createElement('tbody');
  let i = start + 2;
  for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
    body.append(row(mdCells(lines[i]), 'td'));
  }
  table.append(head, body);
  out.appendChild(table);
  return i;
}

export const mdStartsTable = (lines: string[], i: number) =>
  lines[i].includes('|') &&
  lines[i + 1] !== undefined &&
  lines[i + 1].includes('-') &&
  MD_TABLE_RULE.test(lines[i + 1]);

export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = MD_HEADING.exec(line);
    if (!line.trim()) {
      i++;
    } else if (MD_FENCE.test(line)) {
      i = mdCodeBlock(lines, i, out);
    } else if (heading) {
      const el = document.createElement(`h${heading[1].length}`);
      el.append(...mdInline(heading[2]));
      out.append(el);
      i++;
    } else if (MD_RULE.test(line)) {
      out.append(document.createElement('hr'));
      i++;
    } else if (MD_QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && MD_QUOTE.test(lines[i]); i++) quoted.push(lines[i].replace(MD_QUOTE, ''));
      const quote = document.createElement('blockquote');
      quote.append(renderMarkdown(quoted.join('\n')));
      out.append(quote);
    } else if (MD_ITEM.test(line)) {
      i = mdList(lines, i, out);
    } else if (mdStartsTable(lines, i)) {
      i = mdTable(lines, i, out);
    } else {
      // A paragraph runs until a blank line or the start of another block
      const text: string[] = [];
      for (; i < lines.length && lines[i].trim(); i++) {
        const next = lines[i];
        const block =
          MD_FENCE.test(next) ||
          MD_HEADING.test(next) ||
          MD_RULE.test(next) ||
          MD_QUOTE.test(next) ||
          MD_ITEM.test(next) ||
          mdStartsTable(lines, i);
        if (text.length > 0 && block) break;
        text.push(next.trim());
      }
      const p = document.createElement('p');
      p.append(...mdInline(text.join('\n')));
      out.append(p);
    }
  }
  return out;
}
