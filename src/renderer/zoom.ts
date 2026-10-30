import { element, messagesEl } from './shared.js';

const zoomDialog = element<HTMLDialogElement>('zoom-dialog');
const zoomBody = element('zoom-body');

// Clicking a picture or a diagram in a reply opens it larger in a dialog
messagesEl.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest('g.node, g.edge')) return;
  const image = e.target.closest('img.tool-image');
  const diagram = e.target.closest('.diagram');
  if (image instanceof HTMLImageElement) {
    const big = new Image();
    big.src = image.src;
    big.alt = image.alt;
    zoomBody.replaceChildren(big);
  } else if (diagram) {
    const svg = diagram.querySelector('svg');
    if (!svg) return;
    const big = svg.cloneNode(true) as SVGSVGElement;
    big.removeAttribute('width');
    big.removeAttribute('height');
    zoomBody.replaceChildren(big);
  } else {
    return;
  }
  zoomDialog.showModal();
});

element('zoom-close').addEventListener('click', () => zoomDialog.close());
// A click on the dialog itself, rather than on what is inside it, is one on the backdrop
zoomDialog.addEventListener('click', (e) => {
  if (e.target === zoomDialog) zoomDialog.close();
});
zoomDialog.addEventListener('close', () => zoomBody.replaceChildren());
