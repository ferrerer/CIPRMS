// Document Request status-change confirmation (2026-11 investigation).
//
// Root cause / before state: Document Requests — inline status dropdown (bindDrStatusSelects(),
// views/administrator/partnership_requests.ejs) called submitDrStatusChange() the instant the <select>'s
// value changed, with no confirmation step — one misclick on a real request immediately sent the PATCH.
// submitDrStatusChange() itself (the actual PATCH call, its success/error handling, the in-flight/
// double-submit guard, the realtime announce()) is completely unchanged — see
// test/document-request-inline-status.test.js, still passing, for all of that. This suite only covers the
// new confirmation step placed in front of it: a shared modal, populated with the real institution/old/new
// status, that calls submitDrStatusChange() only on an explicit Confirm and leaves the dropdown visually
// reverted the instant a value is picked (so Cancel — or any other way to dismiss the modal — needs no
// separate "undo" step; nothing ever displayed the new value as committed in the first place).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'partnership_requests.ejs'), 'utf8');
const block = (start, len) => src.slice(src.indexOf(start), src.indexOf(start) + len);

describe('Document Requests — status change now requires explicit confirmation', () => {
  test('a shared confirmation modal exists, styled like this page\'s own other modals', () => {
    expect(src).toContain('<div class="modal fade zoomIn" id="dr-status-confirm-modal"');
    const modal = block('id="dr-status-confirm-modal"', 1600);
    expect(modal).toContain('Confirm Status Update');
    expect(modal).toContain('id="dr-confirm-inst"');
    expect(modal).toContain('id="dr-confirm-from"');
    expect(modal).toContain('id="dr-confirm-to"');
    expect(modal).toContain('data-bs-dismiss="modal">Cancel</button>');
    expect(modal).toContain('onclick="confirmDrStatusChange()"');
  });

  test('picking a new status reverts the <select> immediately and opens the confirmation instead of saving', () => {
    const bind = block('function bindDrStatusSelects()', 1100);
    expect(bind).toContain('sel.value = previous;');
    expect(bind).toContain('openDrStatusConfirm(id, previous, next);');
    expect(bind).not.toMatch(/submitDrStatusChange\(id,\s*(sel\.value|next)\)/); // no direct call left in the change handler
  });

  test('the confirmation shows the real institution and the real old -> new status, using the exact same badge rendering the rest of the page already uses', () => {
    const fn = block('function openDrStatusConfirm(', 900);
    expect(fn).toContain("drData.find(x => x.id === id)");
    expect(fn).toContain("document.getElementById('dr-confirm-inst').textContent = r.institution");
    expect(fn).toContain("document.getElementById('dr-confirm-from').innerHTML = statusBadge(previousStatus);");
    expect(fn).toContain("document.getElementById('dr-confirm-to').innerHTML = statusBadge(newStatus);");
  });

  test('Confirm calls the existing, unmodified submitDrStatusChange() — no second/duplicate update path', () => {
    const fn = block('async function confirmDrStatusChange()', 900);
    expect(fn).toContain('await submitDrStatusChange(id, newStatus)');
    expect(fn).not.toMatch(/fetch\(|CIPRMS\.api\(/); // the PATCH itself lives only in submitDrStatusChange(), unchanged
  });

  test('rapid/double-clicking Confirm cannot send two PATCH requests for one confirmation', () => {
    const fn = block('async function confirmDrStatusChange()', 900);
    expect(fn).toContain('if (btn.disabled) return;');
    expect(fn).toContain('btn.disabled = true;');
    expect(fn).toContain('pendingDrStatusChange = null;'); // claimed before the await, not after
    const claimIdx = fn.indexOf('pendingDrStatusChange = null;');
    const awaitIdx = fn.indexOf('await submitDrStatusChange');
    expect(claimIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(claimIdx);
  });

  test('Cancel — or closing the modal any other way (header close, Esc, backdrop) — leaves the pending change unset, never calling submitDrStatusChange()', () => {
    expect(src).toContain("confirmModalEl.addEventListener('hidden.bs.modal', function () { pendingDrStatusChange = null; });");
  });

  test('the confirmation works for every workflow transition, not one hardcoded status pair', () => {
    const fn = block('function openDrStatusConfirm(', 900);
    // Generic (id, previousStatus, newStatus) parameters — nothing here special-cases a specific status string.
    expect(fn).toMatch(/function openDrStatusConfirm\(id, previousStatus, newStatus\)/);
    expect(src).not.toMatch(/if \(newStatus === 'Approved'\).*openDrStatusConfirm/);
  });
});
