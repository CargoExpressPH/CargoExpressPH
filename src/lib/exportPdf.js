import printDocCss from '../styles/print-document.css?inline';

const BOND_CSS = printDocCss.replace(/@media print \{([\s\S]*)\}\s*$/, '$1');

let html2pdfModule = null;
const getHtml2pdf = async () => {
  if (!html2pdfModule) {
    const mod = await import('html2pdf.js');
    html2pdfModule = mod.default || mod;
  }
  return html2pdfModule;
};

export const exportPrintDocumentToPdf = async (filename) => {
  const source = document.querySelector('.print-doc');
  if (!source) throw new Error('Print document is not available yet.');

  const clone = source.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.style.cssText = [
    'position: fixed',
    'left: -99999px',
    'top: 0',
    'width: 816px',
    'display: block',
    'background: #ffffff',
    'color: #000000',
    'font-family: "Times New Roman", Georgia, serif',
    'font-size: 11pt',
    'line-height: 1.45',
    'padding: 72px 67px 82px',
    'z-index: -1',
    'pointer-events: none',
  ].join('; ');

  const style = document.createElement('style');
  style.textContent = BOND_CSS;
  clone.prepend(style);

  document.body.appendChild(clone);
  try {
    const html2pdf = await getHtml2pdf();
    await html2pdf()
      .set({
        margin: [0, 0, 0, 0],
        filename,
        image: { type: 'png' },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(clone)
      .save();
  } finally {
    clone.remove();
  }
};
