// Pre-OCR image quality analysis (IDP upgrade, 2026-07-28) — sharp-based,
// best-effort. Every check is wrapped so a failure here never breaks the OCR
// job itself; a check that can't be computed is simply omitted rather than
// thrown. True geometric rotation/skew detection (Hough-transform style) is
// intentionally NOT attempted here: it would need either a second OCR pass
// with orientation-and-script-detection data or real computer-vision code,
// either of which would add real latency/failure modes to every upload for a
// check this module can't do reliably on its own. Resolution, brightness,
// blur, and edge-cropping are all cheaply and reliably computable from pixel
// stats, so those are the checks implemented.
const sharp = require('sharp');

const MIN_DIMENSION = 1000;
const BRIGHTNESS_LOW = 60;
const BRIGHTNESS_HIGH = 245; // a normal white-paper scan already averages ~220-250 — only flag near-blown-out
const CONTRAST_LOW_FOR_OVEREXPOSED = 15; // "washed out" also requires near-zero contrast, or every clean scan would trip it
const BLUR_STDEV_THRESHOLD = 10;
const EDGE_CONTENT_STDEV_THRESHOLD = 25;

async function analyzeImageQuality(buffer) {
  const warnings = [];
  const metrics = {};

  try {
    const image = sharp(buffer).rotate(); // auto-orient using EXIF, matches ocrService's own preprocessing
    const meta = await image.metadata();
    metrics.width = meta.width || null;
    metrics.height = meta.height || null;

    if (meta.width && meta.height && Math.min(meta.width, meta.height) < MIN_DIMENSION) {
      warnings.push({ code: 'low-resolution', severity: 'warning', message: 'Low resolution — the scan may be too small for reliable text extraction.' });
    }

    try {
      const grayStats = await image.clone().grayscale().stats();
      const meanBrightness = grayStats.channels[0] ? grayStats.channels[0].mean : null;
      const contrast = grayStats.channels[0] ? grayStats.channels[0].stdev : null;
      metrics.brightness = meanBrightness;
      metrics.contrast = contrast;
      if (meanBrightness != null) {
        if (meanBrightness < BRIGHTNESS_LOW) {
          warnings.push({ code: 'too-dark', severity: 'warning', message: 'Image appears too dark — consider rescanning with better lighting.' });
        } else if (meanBrightness > BRIGHTNESS_HIGH && contrast != null && contrast < CONTRAST_LOW_FOR_OVEREXPOSED) {
          // High mean alone is normal for a white-paper scan — only flag when
          // there's also almost no contrast, i.e. text/content isn't visible at all.
          warnings.push({ code: 'too-bright', severity: 'warning', message: 'Image appears washed out / overexposed.' });
        }
      }
    } catch { /* brightness check is best-effort */ }

    try {
      // Laplacian-style edge kernel — a sharp image has strong edge response
      // (high stdev); a blurry one flattens it out (low stdev).
      const edgeStats = await image.clone().grayscale()
        .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
        .stats();
      const sharpness = edgeStats.channels[0] ? edgeStats.channels[0].stdev : null;
      metrics.sharpness = sharpness;
      if (sharpness != null && sharpness < BLUR_STDEV_THRESHOLD) {
        warnings.push({ code: 'blurry', severity: 'warning', message: 'Image appears blurry — text recognition accuracy may be reduced.' });
      }
    } catch { /* blur check is best-effort */ }

    try {
      const w = meta.width, h = meta.height;
      if (w && h && w > 20 && h > 20) {
        const stripW = Math.max(1, Math.round(w * 0.02));
        const stripH = Math.max(1, Math.round(h * 0.02));
        const edgeStrips = await Promise.all([
          image.clone().extract({ left: 0, top: 0, width: w, height: stripH }).grayscale().stats(),
          image.clone().extract({ left: 0, top: h - stripH, width: w, height: stripH }).grayscale().stats(),
          image.clone().extract({ left: 0, top: 0, width: stripW, height: h }).grayscale().stats(),
          image.clone().extract({ left: w - stripW, top: 0, width: stripW, height: h }).grayscale().stats()
        ]);
        const edgeVariance = edgeStrips.map(s => (s.channels[0] ? s.channels[0].stdev : 0));
        metrics.edgeVariance = edgeVariance;
        // High variance right at the very edge of the frame suggests real
        // content (text/lines) is touching the border, i.e. may be cropped —
        // a blank margin would instead read as low, uniform variance.
        if (edgeVariance.some(v => v > EDGE_CONTENT_STDEV_THRESHOLD)) {
          warnings.push({ code: 'possible-crop', severity: 'info', message: 'Content appears close to the image edge — the document may be cropped.' });
        }
      }
    } catch { /* crop heuristic is best-effort */ }
  } catch {
    // Whole analysis failed (e.g. unreadable buffer) — return no metrics/warnings rather than fail the OCR job.
  }

  return { metrics, warnings };
}

module.exports = { analyzeImageQuality };
