// Runs in its own child process (spawned from ocrService.js) so that
// pdf-to-png-converter's bundled pdfjs-dist never loads in the same process
// as pdf-parse's pdfjs-dist — the two ship incompatible major versions, and
// pdfjs throws an "API version does not match Worker version" error if both
// end up initialized together.
const { pdfToPng } = require('pdf-to-png-converter');

async function main() {
  const [, , pdfPath, outDir] = process.argv;
  try {
    const pages = await pdfToPng(pdfPath, {
      // 2 (~144 DPI) was noticeably soft for small/dense print common on scanned MOA/MOU agreements — 3 (~216 DPI)
      // gives Tesseract materially more pixels per character at a still-modest per-page PNG size/render cost.
      viewportScale: 3,
      outputFolder: outDir,
      returnPageContent: false
    });
    process.stdout.write(JSON.stringify({ success: true, files: pages.map((p) => p.path) }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  }
}

main();
