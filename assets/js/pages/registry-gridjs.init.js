// ── Registry – Grid.js init (Velzon pattern) ─────────────────────────────────

var partnerships = [];
var filtered = [];

// Set while the Add New Partnership modal was opened via "Approve" on a
// pending Partnership Request (see checkFromRequestParam()) — carries the
// source request's id so submitPartnership() can link the two records.
// Cleared whenever the modal closes, whether or not it was saved.
var pendingRequestConversion = null;

// ── Institution autocomplete — worldwide university search ───────────────────
// Backed by the /api/institutions proxy (universities.hipolabs.com). Country
// auto-fills exactly from the matched record; region auto-fills from a best-
// effort country→region table and is simply left blank (for manual selection)
// for any country not in it — never guessed.
var COUNTRY_REGION = {
  'Philippines': 'Local',
  'Japan': 'Asia', 'South Korea': 'Asia', 'China': 'Asia', 'Singapore': 'Asia', 'Thailand': 'Asia',
  'Vietnam': 'Asia', 'Malaysia': 'Asia', 'Indonesia': 'Asia', 'India': 'Asia', 'Taiwan': 'Asia',
  'Hong Kong': 'Asia', 'Cambodia': 'Asia', 'Brunei': 'Asia', 'Myanmar': 'Asia', 'Laos': 'Asia',
  'Pakistan': 'Asia', 'Bangladesh': 'Asia', 'Sri Lanka': 'Asia', 'Nepal': 'Asia',
  'United Kingdom': 'Europe', 'Germany': 'Europe', 'France': 'Europe', 'Spain': 'Europe', 'Italy': 'Europe',
  'Netherlands': 'Europe', 'Switzerland': 'Europe', 'Sweden': 'Europe', 'Norway': 'Europe', 'Denmark': 'Europe',
  'Finland': 'Europe', 'Belgium': 'Europe', 'Austria': 'Europe', 'Poland': 'Europe', 'Portugal': 'Europe',
  'Ireland': 'Europe', 'Greece': 'Europe', 'Russia': 'Europe', 'Czech Republic': 'Europe',
  'United States': 'Americas', 'USA': 'Americas', 'Canada': 'Americas', 'Mexico': 'Americas', 'Brazil': 'Americas',
  'Argentina': 'Americas', 'Chile': 'Americas', 'Colombia': 'Americas', 'Peru': 'Americas',
  'Australia': 'Oceania', 'New Zealand': 'Oceania', 'Fiji': 'Oceania',
  'South Africa': 'Africa', 'Nigeria': 'Africa', 'Kenya': 'Africa', 'Egypt': 'Africa', 'Ghana': 'Africa', 'Morocco': 'Africa'
};

var instSearchTimer = null;
var instResults = [];
var instActiveIndex = -1;
var instPrefix = 'f'; // which field set ('f' = Add form, 'e' = Edit modal) the open dropdown belongs to

// HTML-escape untrusted text (institution name/country come from a third-party
// API) before it goes into innerHTML — never trust external API content as safe markup.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Validate a stored document/partner link before it's ever placed into an
// href (2026-09-06 security hardening) — escaping alone protects text
// content but NOT an attribute that can carry its own dangerous scheme
// (javascript:, data:, vbscript:, ...). The Add/Edit Partnership form's
// Document Link field is a native type="url" input seeded with an
// "https://…" placeholder, so only absolute http(s) URLs or the app's own
// relative paths are ever legitimately stored here — anything else is
// refused rather than guessed at.
function sanitizeUrl(url) {
  var s = String(url == null ? '' : url).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '/' && s.charAt(1) !== '/') return s; // same-app relative path, not protocol-relative
  return '';
}

// ── "Responsible Unit" combobox — searchable multi-select restricted to the
// predefined CSPC unit list, with removable chips (2026-09-03). Unlike the
// Document Request combobox elsewhere in this app, no custom/free-text
// entries are allowed here — only these six values are ever selectable.
var UNIT_OPTIONS = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];

function createUnitCombo(prefix) {
  var selected = [];
  var chips = document.getElementById(prefix + '-unit-chips');
  var input = document.getElementById(prefix + '-unit-input');
  var dropdown = document.getElementById(prefix + '-unit-dropdown');
  // A blur (e.g. clicking a chip's remove button, which isn't
  // mousedown-guarded like dropdown options are) schedules a delayed close
  // rather than an immediate one. If the input regains focus before that
  // timer fires, it must be cancelled — otherwise it can fire asynchronously
  // in the middle of a later, unrelated interaction and wipe the dropdown
  // out from under it.
  var blurTimer = null;

  function renderChips() {
    chips.innerHTML = selected.map(function (val, i) {
      return '<span class="unit-chip">' + escapeHtml(val) +
        '<button type="button" data-i="' + i + '" aria-label="Remove ' + escapeHtml(val) + '">&times;</button></span>';
    }).join('');
    chips.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selected.splice(parseInt(btn.getAttribute('data-i'), 10), 1);
        renderChips();
        input.classList.remove('is-invalid');
      });
    });
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
  }

  function addValue(val) {
    if (!val || selected.indexOf(val) !== -1) { input.value = ''; closeDropdown(); return; }
    selected.push(val);
    renderChips();
    input.value = '';
    input.classList.remove('is-invalid');
    closeDropdown();
    input.focus();
  }

  function openDropdown() {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    var q = input.value.trim().toLowerCase();
    // 'focus' and 'click' both fire on a mouse click into an unfocused input,
    // and both call this function — without this guard, the second call
    // rebuilds the option list (a fresh set of DOM nodes) a moment after the
    // first, which can detach the very node a fast synthetic click (e.g.
    // Playwright) is already mid-click on. Skip the rebuild when the
    // dropdown is already open showing this exact query's results.
    if (dropdown.style.display === 'block' && dropdown.dataset.q === q) return;
    dropdown.dataset.q = q;
    var available = UNIT_OPTIONS.filter(function (u) { return selected.indexOf(u) === -1; });
    var matches = q ? available.filter(function (u) { return u.toLowerCase().indexOf(q) !== -1; }) : available;
    dropdown.innerHTML = matches.length
      ? matches.map(function (u) { return '<div class="unit-combo-option" data-val="' + escapeHtml(u) + '">' + escapeHtml(u) + '</div>'; }).join('')
      : '<div class="unit-combo-empty">' + (available.length ? 'No matching unit.' : 'All units selected.') + '</div>';
    dropdown.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    dropdown.querySelectorAll('.unit-combo-option').forEach(function (opt) {
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault();
        addValue(opt.getAttribute('data-val'));
      });
    });
  }

  input.addEventListener('focus', openDropdown);
  // 'click' (not just 'focus') so re-clicking an already-focused input
  // reopens the dropdown after a selection closed it — selecting an option
  // calls input.focus(), which is a no-op (and fires no 'focus' event) when
  // the input is already the active element.
  input.addEventListener('click', openDropdown);
  input.addEventListener('input', openDropdown);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var q = input.value.trim().toUpperCase();
      var match = UNIT_OPTIONS.filter(function (u) { return selected.indexOf(u) === -1; })
        .find(function (u) { return u.toUpperCase() === q || u.toUpperCase().indexOf(q) === 0; });
      if (match) addValue(match);
    } else if (e.key === 'Backspace' && !input.value && selected.length) {
      selected.pop();
      renderChips();
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });
  input.addEventListener('blur', function () { blurTimer = setTimeout(closeDropdown, 120); });

  return {
    getValues: function () { return selected.slice(); },
    setValues: function (vals) {
      // Accepts an array (new records) or a single legacy string value
      // (records created before the 2026-09-03 multi-unit combobox).
      var arr = Array.isArray(vals) ? vals : (vals ? [vals] : []);
      selected = arr.filter(function (v) { return UNIT_OPTIONS.indexOf(v) !== -1; });
      renderChips();
      input.value = '';
    },
    clear: function () { selected = []; renderChips(); input.value = ''; closeDropdown(); },
    markInvalid: function () { input.classList.add('is-invalid'); }
  };
}

document.addEventListener('click', function (e) {
  ['f', 'e'].forEach(function (prefix) {
    var dropdown = document.getElementById(prefix + '-unit-dropdown');
    var input = document.getElementById(prefix + '-unit-input');
    if (dropdown && input && e.target !== input && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
    }
  });
});

function instIds(prefix) {
  return {
    dropdown: prefix === 'e' ? 'e-ac-dropdown' : 'ac-dropdown',
    spinner: prefix === 'e' ? 'e-ac-spinner' : 'ac-spinner',
    inst: prefix === 'e' ? 'e-inst' : 'f-inst',
    country: prefix === 'e' ? 'e-country' : 'f-country',
    region: prefix === 'e' ? 'e-region' : 'f-region'
  };
}

function instSearch(value, prefix) {
  prefix = prefix || 'f';
  instPrefix = prefix;
  var ids = instIds(prefix);
  clearTimeout(instSearchTimer);
  var dropdown = document.getElementById(ids.dropdown);
  var spinner = document.getElementById(ids.spinner);
  var q = (value || '').trim();
  if (q.length < 2) {
    instResults = [];
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
    if (spinner) spinner.style.display = 'none';
    return;
  }
  if (spinner) spinner.style.display = 'inline-block';
  instSearchTimer = setTimeout(function () {
    fetch('/api/institutions?name=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (spinner) spinner.style.display = 'none';
        instResults = Array.isArray(data) ? data : [];
        instActiveIndex = -1;
        renderInstDropdown();
      })
      .catch(function () {
        if (spinner) spinner.style.display = 'none';
        instResults = [];
        renderInstDropdown();
      });
  }, 300); // debounce so we don't hammer the external API on every keystroke
}

function renderInstDropdown() {
  var ids = instIds(instPrefix);
  var dropdown = document.getElementById(ids.dropdown);
  if (!dropdown) return;
  if (!instResults.length) {
    dropdown.innerHTML = '<div class="list-group-item text-muted fs-13">No matching institutions found.</div>';
    dropdown.style.display = 'block';
    return;
  }
  dropdown.innerHTML = instResults.map(function (u, i) {
    return '<button type="button" class="list-group-item list-group-item-action' + (i === instActiveIndex ? ' active' : '') + '" '
      + 'onmousedown="event.preventDefault(); selectInstitution(' + i + ')">'
      + '<div class="fw-semibold fs-13">' + escapeHtml(u.name) + '</div>'
      + '<div class="text-muted fs-12">' + escapeHtml(u.country || '') + '</div>'
      + '</button>';
  }).join('');
  dropdown.style.display = 'block';
}

function selectInstitution(i) {
  var u = instResults[i];
  if (!u) return;
  var ids = instIds(instPrefix);
  var instEl = document.getElementById(ids.inst);
  var countryEl = document.getElementById(ids.country);
  var regionEl = document.getElementById(ids.region);
  if (instEl) instEl.value = u.name;
  if (countryEl) countryEl.value = u.country || '';
  var region = COUNTRY_REGION[u.country];
  if (regionEl && region) regionEl.value = region;

  var dropdown = document.getElementById(ids.dropdown);
  if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
  instResults = [];
  instActiveIndex = -1;
}

function instKeyNav(event, prefix) {
  prefix = prefix || 'f';
  if (!instResults.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    instActiveIndex = Math.min(instActiveIndex + 1, instResults.length - 1);
    renderInstDropdown();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    instActiveIndex = Math.max(instActiveIndex - 1, 0);
    renderInstDropdown();
  } else if (event.key === 'Enter') {
    if (instActiveIndex >= 0) {
      event.preventDefault();
      selectInstitution(instActiveIndex);
    }
  } else if (event.key === 'Escape') {
    var dropdown = document.getElementById(instIds(prefix).dropdown);
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
  }
}

document.addEventListener('click', function (e) {
  ['f', 'e'].forEach(function (prefix) {
    var ids = instIds(prefix);
    var dropdown = document.getElementById(ids.dropdown);
    var input = document.getElementById(ids.inst);
    if (dropdown && input && e.target !== input && !dropdown.contains(e.target)) {
      dropdown.innerHTML = '';
      dropdown.style.display = 'none';
    }
  });
});

// Days remaining until `end` — negative once expired. Used by the table's
// "Days Left" column, the Urgent list, and DSS Smart Alerts (all merged in
// from the former separate Monitoring/Lifecycle page, 2026-09-05).
function computeDays(endStr) {
  var d = new Date(endStr);
  return isNaN(d) ? 0 : Math.ceil((d - new Date()) / 86400000);
}

// Load partnerships from MongoDB API
fetch('/api/partnerships')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    // Normalize: map MongoDB docs to the shape this JS expects
    partnerships = data.map(function(p) {
      return {
        id:           p.id || 0,
        inst:         p.inst || p.institution || p.name || '',
        country:      p.country || '',
        region:       p.region || '',
        type:         p.type || '',
        nature:       p.nature || '',
        cat:          p.cat || p.category || 'International',
        unit:         p.unit || '',
        coordinator:  p.coordinator || '',
        partnerEmail: p.partnerEmail || '',
        docLink:      p.docLink || '',
        startYear:    p.startYear || (p.start ? new Date(p.start).getFullYear() : ''),
        endYear:      p.endYear   || (p.end   ? new Date(p.end).getFullYear()   : ''),
        start:        p.start || '',
        end:          p.end   || '',
        status:       p.status || '',
        remarks:      p.remarks || '',
        days:         computeDays(p.end)
      };
    });
    filtered = partnerships.slice();
    buildGrid();
  })
  .catch(function(err) {
    console.error('Failed to load partnerships:', err);
    buildGrid();
  });


function sbadge(s) {
  var m = { 'Active':'bg-success-subtle text-success', 'Expiring Soon':'bg-warning-subtle text-warning', 'Expired':'bg-danger-subtle text-danger', 'Pending Approval':'bg-info-subtle text-info' };
  return '<span class="badge ' + (m[s]||'bg-secondary-subtle text-secondary') + '">' + s + '</span>';
}

// Days-remaining badge for the table's "Days Left" column — ported from the
// former separate Monitoring/Lifecycle page's own table (2026-09-05 page
// consolidation), so that validity information isn't lost when the two
// tables were merged into one.
function daysBadgeHtml(d, s) {
  if (s === 'Expired') return '<span class="badge bg-danger-subtle text-danger">Expired</span>';
  if (d <= 14)         return '<span class="badge bg-danger">Critical (' + d + 'd)</span>';
  if (d <= 90)         return '<span class="badge bg-warning-subtle text-warning">' + d + ' days</span>';
  return '<span class="badge bg-success-subtle text-success">' + d + ' days</span>';
}

// DSS Smart Alerts — ported from the former separate Monitoring/Lifecycle
// page (2026-09-05 consolidation); same data source (`partnerships`), so the
// advice always matches what the Partnership Registry table below shows.
function renderDssAlerts() {
  var expiringSoon = partnerships.filter(function(p){ return p.status==='Expiring Soon'; }).sort(function(a,b){ return a.days-b.days; });
  var expired = partnerships.filter(function(p){ return p.status==='Expired'; });

  var actionEl = document.getElementById('dss-action-text');
  if (actionEl) {
    if (expiringSoon.length) {
      var soonest = expiringSoon[0];
      actionEl.innerHTML = '<span class="fw-semibold">Action Required:</span> '
        + escapeHtml(soonest.inst) + ' ' + escapeHtml(soonest.type) + ' expires in <strong>' + soonest.days + ' day' + (soonest.days===1?'':'s') + '</strong>. '
        + (expiringSoon.length > 1 ? (expiringSoon.length-1) + ' other partnership' + (expiringSoon.length>2?'s are':' is') + ' also expiring within 90 days.' : 'Consider initiating renewal.');
    } else {
      actionEl.textContent = 'No partnerships are currently expiring within the next 90 days.';
    }
  }

  var reviewEl = document.getElementById('dss-review-text');
  if (reviewEl) {
    if (expired.length) {
      var mostOverdue = expired.slice().sort(function(a,b){ return a.days-b.days; })[0];
      var overdueDays = Math.abs(mostOverdue.days);
      reviewEl.innerHTML = '<span class="fw-semibold">Review Suggested:</span> '
        + escapeHtml(mostOverdue.inst) + ' ' + escapeHtml(mostOverdue.type) + ' expired ' + overdueDays + ' day' + (overdueDays===1?'':'s') + ' ago. '
        + (expired.length > 1 ? (expired.length-1) + ' other expired partnership' + (expired.length>2?'s remain':' remains') + ' unrenewed.' : 'Renew or archive this record.');
    } else {
      reviewEl.textContent = 'No expired partnerships currently require review.';
    }
  }
}

function applyFilter() {
  var q   = (document.getElementById('reg-search')||{value:''}).value.toLowerCase();
  var typ = document.getElementById('reg-type').value;
  var cat = document.getElementById('reg-cat').value;
  var st  = document.getElementById('reg-status').value;
  var reg = document.getElementById('reg-region').value;
  var unt = document.getElementById('reg-unit').value;
  var yrs = document.getElementById('reg-yr-signed').value;
  var yre = document.getElementById('reg-yr-exp').value;
  filtered = partnerships.filter(function(p) {
    return (!q   || p.inst.toLowerCase().includes(q) || p.country.toLowerCase().includes(q))
        && (!typ || p.type === typ)
        && (!cat || p.cat === cat)
        && (!st  || p.status === st)
        && (!reg || p.region === reg)
        // unit is an array on records created via the multi-unit combobox
        // (legacy records still hold a single string) — the filter matches
        // if the chosen unit is any one of the partnership's units.
        && (!unt || (Array.isArray(p.unit) ? p.unit.indexOf(unt) !== -1 : p.unit === unt))
        && (!yrs || p.startYear == yrs)
        && (!yre || p.endYear == yre);
  });
  buildGrid();
}

function clearFilters() {
  ['reg-search','reg-type','reg-cat','reg-status','reg-region','reg-unit','reg-yr-signed','reg-yr-exp'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  applyFilter();
}

function buildGrid() {
  var total    = partnerships.length;
  var nActive  = partnerships.filter(function(p){return p.status==='Active';}).length;
  var nExpiring= partnerships.filter(function(p){return p.status==='Expiring Soon';}).length;
  var nExpiring30 = partnerships.filter(function(p){return p.status==='Expiring Soon' && p.days<=30;}).length;
  var nExpired = partnerships.filter(function(p){return p.status==='Expired';}).length;
  var nMOA     = partnerships.filter(function(p){return p.type==='MOA';}).length;
  var nMOU     = partnerships.filter(function(p){return p.type==='MOU';}).length;
  var nIntl    = partnerships.filter(function(p){return p.cat==='International';}).length;
  var nLocal   = partnerships.filter(function(p){return p.cat==='Local';}).length;
  var activeRate = total ? Math.round(nActive/total*100) : 0;
  function setText(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; }
  setText('cnt-total',total); setText('cnt-active',nActive); setText('cnt-expiring',nExpiring); setText('cnt-expired',nExpired);
  setText('reg-count', filtered.length+' of '+total+' records');
  // Overview (Section 2) — Total/Active/Expiring(30d & 90d split)/Expired/Active
  // Rate/MOA/MOU/International/Local, all from this same `partnerships` array —
  // the one source of truth also driving the KPI cards and the table below.
  setText('ov-total',total); setText('ov-active',nActive);
  setText('ov-expiring30',nExpiring30); setText('ov-expiring90',nExpiring);
  setText('ov-expired',nExpired); setText('ov-active-rate',activeRate+'%');
  setText('ov-moa',nMOA); setText('ov-mou',nMOU); setText('ov-intl',nIntl); setText('ov-local',nLocal);
  var activeBar=document.getElementById('ov-active-bar'), moaBar=document.getElementById('ov-moa-bar'), mouBar=document.getElementById('ov-mou-bar');
  if(activeBar) activeBar.style.width = activeRate+'%';
  if(moaBar) moaBar.style.width = total ? Math.round(nMOA/total*100)+'%' : '0%';
  if(mouBar) mouBar.style.width = total ? Math.round(nMOU/total*100)+'%' : '0%';

  // Urgent (Section 4) — one list, days-based (soonest/most-overdue first),
  // sourced from the same `partnerships` array as everything else on this page.
  var urgent = partnerships.filter(function(p){ return p.status==='Expiring Soon'||p.status==='Expired'; })
    .sort(function(a,b){ return a.days-b.days; })
    .slice(0,7);
  var ul = document.getElementById('urgent-list');
  if (ul) ul.innerHTML = urgent.length===0
    ? '<li class="list-group-item px-3 py-2 text-muted fs-12">No urgent partnerships.</li>'
    : urgent.map(function(p){
        var critical = p.status==='Expired' || p.days<=14;
        var dot = critical ? 'bg-danger' : 'bg-warning';
        var sub = critical ? 'text-danger' : 'text-warning';
        var label = p.status==='Expired' ? 'Expired' : (p.days+' days');
        return '<li class="list-group-item px-3 py-2"><div class="d-flex align-items-center gap-2"><span class="badge '+dot+' rounded-circle p-1">&nbsp;</span><div><div class="fw-semibold fs-13">'+escapeHtml(p.inst)+'</div><div class="text-muted fs-12">'+escapeHtml(p.type)+' &middot; <strong class="'+sub+'">'+label+'</strong></div></div></div></li>';
      }).join('');

  renderDssAlerts();

  var data = filtered.map(function(p) {
    // Type/Unit are intentionally NOT rendered as table columns (2026-09-08
    // UI change) — they still live on `p` and are shown in full in the
    // View/Preview modal (openViewModal below) and everywhere else (Edit
    // form, Reports, filters); this table just no longer duplicates them.
    var statusBadge = sbadge(p.status);
    var endColor    = p.status==='Expired'?'#dc2626':p.status==='Expiring Soon'?'#d97706':'#15803d';
    var instHtml    = escapeHtml(p.inst)+(p.coordinator?'<div class="text-muted fs-11"><i class="ri-user-line me-1"></i>'+escapeHtml(p.coordinator)+'</div>':'');
    var countryHtml = escapeHtml(p.country)+'<div class="text-muted fs-11"><i class="ri-map-pin-line me-1"></i>'+escapeHtml(p.region)+'</div>';
    var endHtml     = '<span style="color:'+endColor+';font-weight:600">'+p.end+'</span>';
    // Mutation controls (Edit/Approve/Renew/Delete) are Administrator- and
    // Staff-only — the View button always shows for every other role.
    // POST/PATCH/DELETE /api/partnerships enforce this server-side regardless.
    var canManage = typeof CAN_MANAGE_REGISTRY !== 'undefined' && CAN_MANAGE_REGISTRY;
    var actions = '<div class="d-flex gap-1 flex-wrap">'
      +'<button class="btn btn-sm btn-soft-info" title="View details" aria-label="View details" onclick="openViewModal('+p.id+')"><i class="ri-eye-line"></i></button>'
      +(!canManage ? '' : (p.status==='Pending Approval'
        ?'<button class="btn btn-sm btn-soft-success" title="Approve" aria-label="Approve" onclick="approveRecord('+p.id+')"><i class="ri-checkbox-circle-line"></i></button>'
        :'<button class="btn btn-sm btn-soft-success" title="Edit" aria-label="Edit" onclick="openEditModal('+p.id+')"><i class="ri-pencil-line"></i></button>'))
      +(!canManage ? '' : (p.status==='Expired'||p.status==='Expiring Soon'
        ?'<button class="btn btn-sm btn-soft-warning" title="Renew" aria-label="Renew" onclick="openRenewModal('+p.id+')"><i class="ri-refresh-line"></i></button>':''))
      +(canManage ? '<button class="btn btn-sm btn-soft-danger" title="Delete" aria-label="Delete" onclick="openDeleteModal('+p.id+')"><i class="ri-delete-bin-line"></i></button>' : '')
      +'</div>';
    return [gridjs.html(instHtml), gridjs.html(countryHtml), p.nature, p.start, gridjs.html(endHtml), gridjs.html(daysBadgeHtml(p.days, p.status)), gridjs.html(statusBadge), gridjs.html(actions)];
  });

  if (window._regGrid) { window._regGrid.updateConfig({data:data}).forceRender(); return; }
  var regGridEl = document.getElementById('reg-grid');
  if (regGridEl) regGridEl.innerHTML = ''; // clear the template's loading placeholder — Grid.js requires an empty container on first render
  regGridEl && (window._regGrid = new gridjs.Grid({
    columns:[
      {name:'Institution',width:'23%'},{name:'Country/Region',width:'14%'},
      {name:'Nature',width:'11%'},{name:'Start',width:'10%'},
      {name:'End',width:'11%'},{name:'Days Left',width:'11%',sort:false},
      {name:'Status',width:'10%',sort:false},{name:'Actions',width:'10%',sort:false}
    ],
    data:data, search:true, pagination:{limit:6}, sort:true,
    className:{table:'table table-hover align-middle mb-0',thead:'table-light',search:'mb-3'},
    language:{search:{placeholder:'Search partnerships\u2026'},pagination:{previous:'\u2190',next:'\u2192',showing:'Showing',results:function(){return 'partnerships';}}}
  }).render(document.getElementById('reg-grid')));
}

// ── Modal helpers ────────────────────────────────────────────────────────────

function openViewModal(id) {
  var p = partnerships.find(function(x){return x.id===id;}); if(!p) return;
  document.getElementById('view-title').textContent = p.inst;
  var safeDocLink = sanitizeUrl(p.docLink);
  var safePartnerEmail = escapeHtml(p.partnerEmail || '');
  document.getElementById('view-body').innerHTML =
    '<div class="row g-3">'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Institution</div><div class="fw-semibold">'+escapeHtml(p.inst)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Country</div><div class="fw-semibold">'+escapeHtml(p.country)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Region</div><div class="fw-semibold">'+escapeHtml(p.region)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Type</div><div class="fw-semibold">'+escapeHtml(p.type)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Nature</div><div class="fw-semibold">'+escapeHtml(p.nature)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Category</div><div class="fw-semibold">'+escapeHtml(p.cat)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Start Date</div><div class="fw-semibold">'+escapeHtml(p.start)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">End Date</div><div class="fw-semibold">'+escapeHtml(p.end)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Status</div><div>'+sbadge(p.status)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Responsible Unit</div><div class="fw-semibold">'+escapeHtml(Array.isArray(p.unit)?p.unit.join(', '):p.unit)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">CIRL Coordinator</div><div class="fw-semibold">'+(p.coordinator?escapeHtml(p.coordinator):'—')+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Partner Email</div><div>'+(p.partnerEmail?'<a href="mailto:'+safePartnerEmail+'">'+safePartnerEmail+'</a>':'—')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Document Link</div><div>'+(safeDocLink?'<a href="'+safeDocLink+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.docLink)+'</a>':(p.docLink?'— Invalid link':'— Not uploaded'))+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Remarks</div><div>'+(p.remarks?escapeHtml(p.remarks):'—')+'</div></div>'
    +'</div>';
  new bootstrap.Modal(document.getElementById('viewPartnershipModal')).show();
}

function approveRecord(id) {
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return;
  if(!confirm('Approve and activate the partnership with "'+p.inst+'"?')) return;
  p.status='Active'; filtered=partnerships.slice(); buildGrid();
  showToast('<i class="ri-checkbox-circle-line"></i> Partnership approved and set to Active!');
}

var deletingId=null;
function openDeleteModal(id){ deletingId=id; new bootstrap.Modal(document.getElementById('deleteRecordModal')).show(); }
function confirmDelete(){
  if(!deletingId) return;
  var idx=partnerships.findIndex(function(x){return x.id===deletingId;}); if(idx===-1) return;
  var name=partnerships[idx].inst;
  fetch('/api/partnerships/'+deletingId,{method:'DELETE'})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        partnerships.splice(idx,1); deletingId=null;
        bootstrap.Modal.getInstance(document.getElementById('deleteRecordModal'))?.hide();
        applyFilter(); showToast('"'+name+'" has been removed from the registry.');
      }
    }).catch(function(e){console.error(e);showToast('Error deleting partnership.');});
}

var editingId=null;
var eUnitCombo = createUnitCombo('e');
function openEditModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; editingId=id;
  var toISO=function(s){var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);};
  document.getElementById('e-inst').value=p.inst; document.getElementById('e-country').value=p.country;
  document.getElementById('e-region').value=p.region; document.getElementById('e-partner-email').value=p.partnerEmail||'';
  document.getElementById('e-type').value=p.type; document.getElementById('e-nature').value=p.nature;
  document.getElementById('e-cat').value=p.cat; document.getElementById('e-start').value=toISO(p.start);
  document.getElementById('e-end').value=toISO(p.end); document.getElementById('e-status').value=p.status;
  eUnitCombo.setValues(p.unit); document.getElementById('e-coordinator').value=p.coordinator||'';
  document.getElementById('e-doclink').value=p.docLink||''; document.getElementById('e-remarks').value=p.remarks||'';
  new bootstrap.Modal(document.getElementById('editPartnershipModal')).show();
}
function computeEditStatus(){var v=document.getElementById('e-end').value;if(!v)return;var d=Math.ceil((new Date(v)-new Date())/86400000);document.getElementById('e-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';}
function saveEdit(){
  var inst=document.getElementById('e-inst').value.trim(),end=document.getElementById('e-end').value;
  var units=eUnitCombo.getValues();
  if(!inst||!end||!units.length){
    if(!units.length) eUnitCombo.markInvalid();
    showToast('Institution name, End Date, and at least one Responsible Unit are required.');
    return;
  }
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===editingId;}); if(!p) return;
  var updates={inst:inst,country:document.getElementById('e-country').value.trim(),region:document.getElementById('e-region').value,
    partnerEmail:document.getElementById('e-partner-email').value.trim(),type:document.getElementById('e-type').value,
    nature:document.getElementById('e-nature').value,cat:document.getElementById('e-cat').value,
    start:fmt(document.getElementById('e-start').value),end:fmt(end),endYear:new Date(end).getFullYear(),
    status:document.getElementById('e-status').value,unit:units,
    coordinator:document.getElementById('e-coordinator').value.trim(),docLink:document.getElementById('e-doclink').value.trim(),
    remarks:document.getElementById('e-remarks').value.trim()};
  fetch('/api/partnerships/'+editingId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        Object.assign(p,updates); p.days=computeDays(p.end);
        bootstrap.Modal.getInstance(document.getElementById('editPartnershipModal'))?.hide();
        applyFilter();showToast('"'+inst+'" updated successfully.');
      }
    }).catch(function(e){console.error(e);showToast('Error updating partnership.');});
}

var renewingId=null;
function openRenewModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; renewingId=id;
  document.getElementById('renew-inst-name').textContent=p.inst;
  document.getElementById('renew-inst-sub').textContent=p.type+' \u00b7 '+p.country+' \u00b7 Previously expired: '+p.end;
  document.getElementById('renew-prev-end').value=p.end;
  document.getElementById('renew-new-end').value='';document.getElementById('renew-validity').value='';
  document.getElementById('renew-status').value='';document.getElementById('renew-remarks').value='';
  new bootstrap.Modal(document.getElementById('renewPartnershipModal')).show();
}
function computeRenewStatus(){
  var v=document.getElementById('renew-new-end').value; if(!v) return;
  var ed=new Date(v),d=Math.ceil((ed-new Date())/86400000);
  document.getElementById('renew-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';
  var now=new Date(),tot=(ed.getFullYear()-now.getFullYear())*12+(ed.getMonth()-now.getMonth());
  var y=Math.floor(tot/12),m=tot%12;
  document.getElementById('renew-validity').value=(y>0?y+' yr'+(y>1?'s':''):'')+(m>0?(y>0?' ':'')+m+' mo':'')||'< 1 month';
}
function saveRenew(){
  var newEnd=document.getElementById('renew-new-end').value; if(!newEnd){showToast('Please set a new end date.');return;}
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===renewingId;}); if(!p) return;
  var d=Math.ceil((new Date(newEnd)-new Date())/86400000);
  var updates={end:fmt(newEnd),endYear:new Date(newEnd).getFullYear(),status:d<0?'Expired':d<=90?'Expiring Soon':'Active'};
  var rmk=document.getElementById('renew-remarks').value.trim(); if(rmk) updates.remarks=rmk;
  fetch('/api/partnerships/'+renewingId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        Object.assign(p,updates); p.days=computeDays(p.end);
        bootstrap.Modal.getInstance(document.getElementById('renewPartnershipModal'))?.hide();
        applyFilter();showToast('"'+p.inst+'" renewed \u2014 new end date: '+p.end+'.');
      }
    }).catch(function(e){console.error(e);showToast('Error renewing partnership.');});
}

var toastTimer=null;
function showToast(msg){
  var t=document.getElementById('reg-toast');
  document.getElementById('reg-toast-msg').textContent=msg;
  t.style.display='flex';
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.style.display='none';},3500);
}

function computeStatus(){var v=document.getElementById('f-end').value;if(!v)return;var d=Math.ceil((new Date(v)-new Date())/86400000);document.getElementById('f-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';}

// \u2500\u2500 OCR auto-fill (Extract using OCR button in the Add Partnership modal) \u2500\u2500\u2500\u2500
var ocrExtractedResult = null;
var ocrPollTimer = null;
var OCR_MAX_FILE_SIZE = 10 * 1024 * 1024;
var OCR_ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];

function ocrShow(id, on) { var el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }

function startOcrExtraction() {
  var input = document.getElementById('ocr-file-input');
  var file = input.files[0];
  if (!file) { showToast('Choose a file first.'); return; }

  var ext = '.' + file.name.split('.').pop().toLowerCase();
  if (OCR_ALLOWED_EXT.indexOf(ext) === -1) { showToast('Unsupported file type. Use PDF, JPG, JPEG, or PNG.'); return; }
  if (file.size > OCR_MAX_FILE_SIZE) { showToast('File is too large. Maximum size is 10MB.'); return; }

  ocrShow('ocr-error-box', false);
  ocrShow('ocr-result-box', false);
  ocrShow('ocr-progress-wrap', true);
  document.getElementById('ocr-stage-text').textContent = 'Uploading\u2026';
  document.getElementById('ocr-percent-text').textContent = '0%';
  document.getElementById('ocr-progress-bar').style.width = '0%';
  document.getElementById('ocr-extract-btn').disabled = true;

  var formData = new FormData();
  formData.append('document', file);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/ocr/extract');
  xhr.upload.addEventListener('progress', function (e) {
    if (!e.lengthComputable) return;
    var pct = Math.round((e.loaded / e.total) * 100);
    document.getElementById('ocr-progress-bar').style.width = pct + '%';
    document.getElementById('ocr-percent-text').textContent = pct + '%';
  });
  xhr.onload = function () {
    var data;
    try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
    if (xhr.status !== 202 || !data || !data.success) {
      ocrFail((data && data.error) || 'Failed to start OCR processing.');
      return;
    }
    document.getElementById('ocr-stage-text').textContent = 'OCR Processing\u2026';
    pollOcrStatus(data.jobId);
  };
  xhr.onerror = function () { ocrFail('Network error while uploading the document.'); };
  xhr.send(formData);
}

function pollOcrStatus(jobId) {
  clearTimeout(ocrPollTimer);
  fetch('/api/ocr/status/' + jobId)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) { ocrFail(data.error || 'Job not found.'); return; }
      var pct = data.progress || 0;
      document.getElementById('ocr-progress-bar').style.width = pct + '%';
      document.getElementById('ocr-percent-text').textContent = pct + '%';
      document.getElementById('ocr-stage-text').textContent = 'OCR Processing\u2026 (' + (data.stage || '') + ')';

      if (data.status === 'error') { ocrFail(data.error || 'OCR processing failed.'); return; }
      if (data.status === 'done') { ocrSucceed(data.result); return; }
      ocrPollTimer = setTimeout(function () { pollOcrStatus(jobId); }, 700);
    })
    .catch(function () { ocrFail('Lost connection while checking OCR progress.'); });
}

function ocrFail(message) {
  document.getElementById('ocr-extract-btn').disabled = false;
  ocrShow('ocr-progress-wrap', false);
  var box = document.getElementById('ocr-error-box');
  box.textContent = message;
  ocrShow('ocr-error-box', true);
  showToast('OCR error: ' + message);
}

function ocrSucceed(result) {
  ocrExtractedResult = result;
  document.getElementById('ocr-extract-btn').disabled = false;
  ocrShow('ocr-progress-wrap', false);
  ocrShow('ocr-result-box', true);
  document.getElementById('ocr-confidence-badge').textContent = 'Confidence: ' + Math.round(result.confidence) + '%';
  document.getElementById('ocr-doctype-badge').textContent = 'Document type: ' + (result.documentType || 'Unrecognized');
  document.getElementById('ocr-raw-text').textContent = result.rawText;
  ocrShow('ocr-warning-badge', !!result.warning);
  if (window.IDP) {
    IDP.renderResult('ocr-idp-panel', result, {
      onCancelDuplicate: function (documentId) {
        if (!documentId) return;
        fetch('/api/documents/' + documentId + '/organize', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
        }).then(function () { showToast('Upload archived \u2014 it will no longer appear as an active Document Library entry.'); });
      },
      onViewDuplicate: function (fileLink) { window.open(fileLink, '_blank'); }
    });
  }
  showToast('OCR extraction complete \u2014 review the suggested values, then apply them to the form.');
}

function ocrIsoDate(str) {
  if (!str) return '';
  var d = new Date(str);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function ocrSetIfPresent(id, value) {
  if (value === null || value === undefined || value === '') return;
  var el = document.getElementById(id);
  if (el) el.value = value;
}

function applyOcrToForm() {
  if (!ocrExtractedResult) return;
  var r = ocrExtractedResult;

  var filled = [];
  function set(id, value) {
    if (value === null || value === undefined || value === '') return;
    var el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    filled.push(id);
  }

  set('f-inst', r.institution);
  set('f-partner-email', r.email);
  set('f-country', r.country);
  set('f-region', r.region);
  set('f-cat', r.category);

  if (r.documentType) {
    if (/agreement/i.test(r.documentType)) set('f-type', 'MOA');
    else if (/understanding/i.test(r.documentType)) set('f-type', 'MOU');
  }
  // f-nature's options don't cover every value inferNature() can produce
  // (e.g. Technology Transfer, Community Outreach) — only apply an exact,
  // unambiguous match rather than forcing an incorrect one.
  if (r.nature) {
    var natureSelect = document.getElementById('f-nature');
    if (natureSelect) {
      var opt = Array.prototype.find.call(natureSelect.options, function (o) { return o.value.toLowerCase() === r.nature.toLowerCase(); });
      if (opt) set('f-nature', opt.value);
    }
  }

  var startIso = ocrIsoDate(r.startDate);
  var endIso = ocrIsoDate(r.endDate);
  if (startIso) set('f-start', startIso);
  if (endIso) set('f-end', endIso);
  if (endIso) computeStatus();

  if (window.IDP) filled.forEach(IDP.markFilled);

  // Fields with no dedicated input on this form are folded into Remarks so
  // nothing extracted gets silently discarded \u2014 the user can trim/edit freely.
  var extras = [];
  if (r.partner) extras.push('Partner: ' + r.partner);
  if (r.title) extras.push('Title: ' + r.title);
  if (r.duration) extras.push('Duration: ' + r.duration);
  if (r.address) extras.push('Address: ' + r.address);
  if (r.contactNumber) extras.push('Contact: ' + r.contactNumber);
  if (r.signatories && r.signatories.length) extras.push('Signatories: ' + r.signatories.join('; '));
  if (r.purpose) extras.push('Purpose: ' + r.purpose);
  if (r.objectives) extras.push('Objectives: ' + r.objectives);
  if (r.scope) extras.push('Scope: ' + r.scope);
  if (extras.length) {
    var remarksEl = document.getElementById('f-remarks');
    var prefix = remarksEl.value ? remarksEl.value + '\n\n' : '';
    remarksEl.value = prefix + '[From OCR] ' + extras.join(' | ');
  }

  var firstTab = document.getElementById('add-step1-tab');
  if (firstTab) new bootstrap.Tab(firstTab).show();
  showToast('Suggested values applied \u2014 please review every field before saving.');
}

function dismissOcrResult() {
  ocrExtractedResult = null;
  ocrShow('ocr-result-box', false);
  ocrShow('ocr-error-box', false);
  document.getElementById('ocr-file-input').value = '';
}

// ── Approved-Request → Registry conversion ──────────────────────────────────
// "Approve" on a pending Partnership Request (partnership_requests.ejs)
// redirects here as /registry?fromRequest=<id> instead of flipping the
// request's status directly — the request is only marked Approved once the
// reviewer actually saves a partnership from this same Add New Partnership
// form (see submitPartnership() below and POST /api/partnerships).
function hideFromRequestBanner() {
  var banner = document.getElementById('from-request-banner');
  // Bootstrap's d-flex utility is !important — toggle it off along with
  // adding d-none rather than setting style.display, or d-flex would win.
  if (banner) { banner.classList.remove('d-flex'); banner.classList.add('d-none'); }
  var instEl = document.getElementById('from-request-inst');
  if (instEl) instEl.textContent = '';
}

function clearFromRequestParam() {
  if (window.location.search.indexOf('fromRequest=') === -1) return;
  var url = new URL(window.location.href);
  url.searchParams.delete('fromRequest');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

// Mirrors applyOcrToForm()'s field-by-field, only-apply-if-recognized
// approach — request field options don't perfectly overlap the Registry
// form's own option lists (e.g. Nature of Partnership), so anything that
// doesn't match exactly is simply left for the reviewer to pick themselves
// rather than forcing a wrong value in.
function applyRequestToForm(r) {
  function set(id, value) {
    if (!value) return;
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  set('f-inst', r.institution);
  set('f-country', r.country);
  set('f-region', r.region);
  set('f-cat', r.category);

  if (r.type === 'MOA' || r.type === 'MOU') set('f-type', r.type);

  if (r.nature) {
    var natureSelect = document.getElementById('f-nature');
    if (natureSelect) {
      var opt = Array.prototype.find.call(natureSelect.options, function (o) {
        return o.value.toLowerCase() === r.nature.toLowerCase();
      });
      if (opt) set('f-nature', opt.value);
    }
  }

  var startIso = ocrIsoDate(r.startDate);
  var endIso = ocrIsoDate(r.endDate);
  if (startIso) set('f-start', startIso);
  if (endIso) { set('f-end', endIso); computeStatus(); }

  if (r.unit) fUnitCombo.setValues(r.unit);

  var remarksParts = ['[From Partnership Request #REQ-' + String(r.id).padStart(3, '0') + ']'];
  if (r.notes) remarksParts.push(r.notes);
  document.getElementById('f-remarks').value = remarksParts.join(' ');

  var banner = document.getElementById('from-request-banner');
  if (banner) { banner.classList.remove('d-none'); banner.classList.add('d-flex'); }
  var instEl = document.getElementById('from-request-inst');
  if (instEl) instEl.textContent = r.institution ? (' — ' + r.institution) : '';

  var firstTab = document.getElementById('add-step1-tab');
  if (firstTab) new bootstrap.Tab(firstTab).show();
}

// Runs once on page load. Reuses the existing /api/requests endpoint (already
// returns every request to Administrator/Staff — see REQUEST_REVIEWER_ROLES
// in cirl.js) rather than adding a new single-request route.
function checkFromRequestParam() {
  var params = new URLSearchParams(window.location.search);
  var raw = params.get('fromRequest');
  if (!raw) return;
  var reqId = parseInt(raw, 10);
  if (!reqId) return;

  fetch('/api/requests')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var match = Array.isArray(list) ? list.find(function (x) { return x.id === reqId; }) : null;
      if (!match) {
        showToast('Could not open the source partnership request — it may have been removed.');
        clearFromRequestParam();
        return;
      }
      if (match.linkedPartnershipId) {
        showToast('This request has already been converted to a Registry partnership.');
        clearFromRequestParam();
        return;
      }
      if (match.status !== 'Pending' && match.status !== 'Under Review') {
        showToast('This request is no longer available for conversion (status: ' + match.status + ').');
        clearFromRequestParam();
        return;
      }

      pendingRequestConversion = reqId;
      var modalEl = document.getElementById('addPartnershipModal');
      if (!modalEl) return;
      var modal = new bootstrap.Modal(modalEl);
      modalEl.addEventListener('shown.bs.modal', function onShown() {
        modalEl.removeEventListener('shown.bs.modal', onShown);
        applyRequestToForm(match);
      });
      modal.show();
    })
    .catch(function () {
      showToast('Could not load the source partnership request. Please try Approve again.');
      clearFromRequestParam();
    });
}

function highlight(id,on){var el=document.getElementById(id);if(!el)return;el.style.borderColor=on?'#dc2626':'';el.addEventListener('input',function(){el.style.borderColor='';},{once:true});}

var fUnitCombo = createUnitCombo('f');

function submitPartnership(){
  var inst=document.getElementById('f-inst').value.trim(),type=document.getElementById('f-type').value,
      start=document.getElementById('f-start').value,end=document.getElementById('f-end').value,
      units=fUnitCombo.getValues(),region=document.getElementById('f-region').value;
  if(!inst)highlight('f-inst',true);if(!type)highlight('f-type',true);
  if(!start)highlight('f-start',true);if(!end)highlight('f-end',true);if(!units.length)fUnitCombo.markInvalid();
  if(!inst||!type||!start||!end||!units.length)return;
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var d=Math.ceil((new Date(end)-new Date())/86400000);
  var status=document.getElementById('f-status').value||(d<0?'Expired':d<=90?'Expiring Soon':'Active');
  var payload={inst:inst,country:document.getElementById('f-country').value.trim()||'—',
    region:region||'—',type:type,nature:document.getElementById('f-nature').value||'—',
    cat:document.getElementById('f-cat').value||'International',unit:units,
    coordinator:document.getElementById('f-coordinator').value.trim(),
    partnerEmail:document.getElementById('f-partner-email').value.trim(),
    docLink:document.getElementById('f-doc-link').value.trim(),
    startYear:new Date(start).getFullYear(),endYear:new Date(end).getFullYear(),
    start:fmt(start),end:fmt(end),status:status,remarks:document.getElementById('f-remarks').value.trim()};
  if(pendingRequestConversion) payload.sourceRequestId=pendingRequestConversion;
  fetch('/api/partnerships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})
    .then(function(res){
      var data=res.data;
      if(res.ok&&data.success){
        // If this was already converted by an earlier attempt, the returned
        // partnership may already be in the list — avoid a visible duplicate row.
        if(!partnerships.some(function(p){return p.id===data.partnership.id;})){
          data.partnership.days = computeDays(data.partnership.end);
          partnerships.push(data.partnership);
        }
        filtered=partnerships.slice();applyFilter();
        pendingRequestConversion=null;
        bootstrap.Modal.getInstance(document.getElementById('addPartnershipModal'))?.hide();
        showToast(data.alreadyConverted
          ? '"'+inst+'" was already converted to a Registry partnership.'
          : '"'+inst+'" added to the registry.');
      } else {
        showToast(data.error||'Error saving partnership. Please try again.');
      }
    }).catch(function(e){console.error(e);showToast('Error saving partnership. Please try again.');});
}

// ── DOMContentLoaded ─────────────────────────────────────────────────────────
// Note: buildGrid() is called by the fetch().then() above
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.nexttab').forEach(function(btn){
    btn.addEventListener('click',function(){var t=document.getElementById(this.getAttribute('data-nexttab'));if(t)new bootstrap.Tab(t).show();});
  });
  document.querySelectorAll('.previestab').forEach(function(btn){
    btn.addEventListener('click',function(){var t=document.getElementById(this.getAttribute('data-previous'));if(t)new bootstrap.Tab(t).show();});
  });
  var addModal=document.getElementById('addPartnershipModal');
  if(addModal) addModal.addEventListener('show.bs.modal',function(){
    var ft=document.getElementById('add-step1-tab');if(ft)new bootstrap.Tab(ft).show();
    document.getElementById('addPartnershipForm').reset();
    fUnitCombo.clear();
    dismissOcrResult();
    ocrShow('ocr-progress-wrap', false);
    hideFromRequestBanner();
  });
  if(addModal) addModal.addEventListener('hidden.bs.modal',function(){
    // Fires on every close — a successful save (already cleared above), a
    // cancelled request-conversion, or a plain manual Add — so a stale
    // sourceRequestId never leaks into an unrelated later save.
    pendingRequestConversion=null;
    hideFromRequestBanner();
    clearFromRequestParam();
  });

  checkFromRequestParam();
});

