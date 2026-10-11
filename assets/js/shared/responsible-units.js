// ── Shared Responsible Unit list + "Add Responsible Unit" modal (2026-11) ───────────────────────────
// Single source of truth for every page that offers a Responsible Unit / College-Unit picker — the Registry
// Add/Edit Partnership combobox (registry-gridjs.init.js) and the Reports & Analytics Custom Report Builder
// + Comparison College/Unit fields (reports.ejs) all load this file, read the same UNIT_OPTIONS array, and
// share the one "Add Responsible Unit" modal (views/partials/add_unit_modal.ejs) and its POST
// /api/responsible-units call — so there is exactly one Responsible Unit list and one creation path in this
// application, never a second unit-management system or a duplicate record.
//
// Originally lived only in registry-gridjs.init.js (2026-11 Responsible Unit investigation); extracted here
// so Reports & Analytics' College/Unit filter and Comparison fields can offer the exact same "Add New Unit"
// capability instead of each page growing its own copy.
var UNIT_OPTIONS = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];

function loadResponsibleUnits() {
  return CIPRMS.api('/api/responsible-units', { quiet: true }).then(function (res) {
    if (!res.ok || !Array.isArray(res.data)) return; // keep the seed fallback above — never leave the field with no options at all
    var names = res.data.map(function (u) { return u.name; });
    UNIT_OPTIONS.length = 0;
    Array.prototype.push.apply(UNIT_OPTIONS, names);
  }).catch(function () { /* network hiccup — the seed fallback list above still works for this page view */ });
}

// A toast confirming the new unit was added — reuses whichever toast mechanism the including page already
// has (registry-gridjs.init.js's own showToast()/#reg-toast on Monitoring, so that page's Add-Unit success
// message looks identical to every other action's toast on it) and falls back to the generic CIPRMS.toast()
// (loaded on every authenticated page via header.ejs) for pages, like Reports & Analytics, that never built
// their own toast bar.
function notifyUnitAdded(message) {
  if (typeof window.showToast === 'function') { window.showToast(message); }
  else if (window.CIPRMS && typeof window.CIPRMS.toast === 'function') { window.CIPRMS.toast(message); }
}

// ── Add Responsible Unit — the small modal opened from any page's "+ Add" trigger (Monitoring's Unit combo
// dropdown row, or Reports & Analytics' College/Unit "+" button). Deliberately NOT nested inside/replacing
// whichever modal or view is already open when this is triggered — Bootstrap 5 stacks multiple shown modals
// correctly on its own (each gets its own backdrop, z-index climbs per modal), so whatever the person was
// already doing stays open and untouched underneath while this one small modal is answered.
var pendingUnitCombo = null; // whichever caller's { addValue(name) } opened this — the only method ever called on it

function openAddResponsibleUnitModal(comboApi) {
  pendingUnitCombo = comboApi;
  var input = document.getElementById('new-unit-name');
  var err = document.getElementById('new-unit-error');
  var btn = document.getElementById('new-unit-add-btn');
  if (input) { input.value = ''; input.classList.remove('is-invalid'); }
  if (err) { err.textContent = ''; err.classList.add('d-none'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Add Unit'; }
  modalInstanceGlobal('add-unit-modal').show();
  setTimeout(function () { if (input) input.focus(); }, 150); // after the modal's own fade-in, same as Bootstrap's own autofocus examples
}

function modalInstanceGlobal(id) { return bootstrap.Modal.getOrCreateInstance(document.getElementById(id)); }

async function submitAddResponsibleUnit() {
  var input = document.getElementById('new-unit-name');
  var err = document.getElementById('new-unit-error');
  var btn = document.getElementById('new-unit-add-btn');
  var name = (input.value || '').trim();
  if (!name) {
    input.classList.add('is-invalid');
    err.textContent = 'Unit name is required.';
    err.classList.remove('d-none');
    input.focus();
    return;
  }
  if (btn.disabled) return; // guards rapid double-click the same way the Document Request confirm button does
  btn.disabled = true;
  btn.textContent = 'Adding…';
  err.classList.add('d-none');
  try {
    var res = await CIPRMS.api('/api/responsible-units', { method: 'POST', json: { name: name }, quiet: true });
    if (!res.ok || !res.data || !res.data.success) {
      input.classList.add('is-invalid');
      err.textContent = res.error || 'Unable to add this Responsible Unit. Please try again.';
      err.classList.remove('d-none');
      btn.disabled = false;
      btn.textContent = 'Add Unit';
      return;
    }
    var savedName = res.data.unit.name;
    // Keeps whatever the server actually stored (its own trim is authoritative) in sync everywhere this
    // shared array is read — every page's Unit combo/dropdown sees it on their very next render, with no
    // further network round trip (and so nothing here to "fail" the way a second refresh fetch could).
    if (UNIT_OPTIONS.indexOf(savedName) === -1) UNIT_OPTIONS.push(savedName);
    if (pendingUnitCombo) {
      try { pendingUnitCombo.addValue(savedName); }
      catch (renderErr) {
        // The unit really was saved (it's already in UNIT_OPTIONS above) — only this one caller's own
        // on-screen refresh broke. Say so accurately rather than claiming nothing happened, and never
        // retry the POST automatically (that would risk a duplicate-name conflict for a save that already
        // succeeded).
        console.error('Responsible Unit saved, but refreshing this field failed:', renderErr);
        notifyUnitAdded('"' + savedName + '" was saved, but this field could not refresh automatically. Please reopen it or reload the page.');
        modalInstanceGlobal('add-unit-modal').hide();
        return;
      }
    }
    modalInstanceGlobal('add-unit-modal').hide();
    // Plain text, not HTML — both showToast() (textContent) and CIPRMS.toast() (textContent) render this
    // literally, so no markup belongs in the message itself.
    notifyUnitAdded('"' + savedName + '" added as a Responsible Unit.');
  } catch (e) {
    input.classList.add('is-invalid');
    err.textContent = 'Network error while adding this unit. Please try again.';
    err.classList.remove('d-none');
    btn.disabled = false;
    btn.textContent = 'Add Unit';
  }
}

document.addEventListener('DOMContentLoaded', function () {
  loadResponsibleUnits();
  var addUnitInput = document.getElementById('new-unit-name');
  if (addUnitInput) addUnitInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitAddResponsibleUnit(); } });
});
