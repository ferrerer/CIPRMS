// ── Registry – Grid.js init (Velzon pattern) ─────────────────────────────────

var partnerships = [];
var filtered = [];

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
        remarks:      p.remarks || ''
      };
    });
    filtered = partnerships.slice();
    buildGrid();
    initCounters();
  })
  .catch(function(err) {
    console.error('Failed to load partnerships:', err);
    buildGrid();
  });


function sbadge(s) {
  var m = { 'Active':'bg-success-subtle text-success', 'Expiring Soon':'bg-warning-subtle text-warning', 'Expired':'bg-danger-subtle text-danger', 'Pending Approval':'bg-info-subtle text-info' };
  return '<span class="badge ' + (m[s]||'bg-secondary-subtle text-secondary') + '">' + s + '</span>';
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
        && (!unt || p.unit === unt)
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
  var nExpired = partnerships.filter(function(p){return p.status==='Expired';}).length;
  var nMOA     = partnerships.filter(function(p){return p.type==='MOA';}).length;
  var nMOU     = partnerships.filter(function(p){return p.type==='MOU';}).length;
  var nIntl    = partnerships.filter(function(p){return p.cat==='International';}).length;
  var nLocal   = partnerships.filter(function(p){return p.cat==='Local';}).length;
  function setText(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; }
  setText('cnt-total',total); setText('cnt-active',nActive); setText('cnt-expiring',nExpiring); setText('cnt-expired',nExpired);
  setText('reg-count', filtered.length+' of '+total+' records');
  setText('ov-total',total); setText('ov-active',nActive); setText('ov-expiring',nExpiring); setText('ov-expired',nExpired);
  setText('ov-moa',nMOA); setText('ov-mou',nMOU); setText('ov-intl',nIntl); setText('ov-local',nLocal);
  var moaBar=document.getElementById('ov-moa-bar'), mouBar=document.getElementById('ov-mou-bar');
  if(moaBar) moaBar.style.width = total ? Math.round(nMOA/total*100)+'%' : '0%';
  if(mouBar) mouBar.style.width = total ? Math.round(nMOU/total*100)+'%' : '0%';

  var urgent = partnerships.filter(function(p){ return p.status==='Expiring Soon'||p.status==='Expired'; })
    .sort(function(a,b){ return (a.status==='Expired'?0:1)-(b.status==='Expired'?0:1); });
  var ul = document.getElementById('urgent-list');
  if (ul) ul.innerHTML = urgent.length===0
    ? '<li class="list-group-item px-3 py-2 text-muted fs-12">No urgent items.</li>'
    : urgent.map(function(p){
        var dot=p.status==='Expired'?'bg-danger':'bg-warning';
        var sub=p.status==='Expired'?'text-danger':'text-warning';
        return '<li class="list-group-item px-3 py-2"><div class="d-flex align-items-center gap-2"><span class="badge '+dot+' rounded-circle p-1">&nbsp;</span><div><div class="fw-semibold fs-13">'+p.inst+'</div><div class="text-muted fs-12">'+p.type+' &middot; <strong class="'+sub+'">'+p.status+'</strong></div></div></div></li>';
      }).join('');

  var data = filtered.map(function(p) {
    var typeBadge   = '<span class="badge '+(p.type==='MOU'?'bg-info-subtle text-info':'bg-primary-subtle text-primary')+'">'+p.type+'</span>';
    var unitBadge   = '<span class="badge bg-success-subtle text-success">'+p.unit+'</span>';
    var statusBadge = sbadge(p.status);
    var endColor    = p.status==='Expired'?'#dc2626':p.status==='Expiring Soon'?'#d97706':'#15803d';
    var instHtml    = p.inst+(p.coordinator?'<div class="text-muted fs-11"><i class="ri-user-line me-1"></i>'+p.coordinator+'</div>':'');
    var countryHtml = p.country+'<div class="text-muted fs-11"><i class="ri-map-pin-line me-1"></i>'+p.region+'</div>';
    var endHtml     = '<span style="color:'+endColor+';font-weight:600">'+p.end+'</span>';
    // Mutation controls (Edit/Approve/Renew/Delete) are Administrator-only — the
    // View button always shows, matching Staff's read-only Registry access.
    // POST/PATCH/DELETE /api/partnerships enforce this server-side regardless.
    var canManage = typeof CAN_MANAGE_REGISTRY !== 'undefined' && CAN_MANAGE_REGISTRY;
    var actions = '<div class="d-flex gap-1 flex-wrap">'
      +'<button class="btn btn-sm btn-soft-info" onclick="openViewModal('+p.id+')"><i class="ri-eye-line"></i></button>'
      +(!canManage ? '' : (p.status==='Pending Approval'
        ?'<button class="btn btn-sm btn-soft-success" onclick="approveRecord('+p.id+')"><i class="ri-checkbox-circle-line"></i></button>'
        :'<button class="btn btn-sm btn-soft-success" onclick="openEditModal('+p.id+')"><i class="ri-pencil-line"></i></button>'))
      +(!canManage ? '' : (p.status==='Expired'||p.status==='Expiring Soon'
        ?'<button class="btn btn-sm btn-soft-warning" onclick="openRenewModal('+p.id+')"><i class="ri-refresh-line"></i></button>':''))
      +(canManage ? '<button class="btn btn-sm btn-soft-danger" onclick="openDeleteModal('+p.id+')"><i class="ri-delete-bin-line"></i></button>' : '')
      +'</div>';
    return [gridjs.html(instHtml), gridjs.html(countryHtml), gridjs.html(typeBadge), p.nature, gridjs.html(unitBadge), p.start, gridjs.html(endHtml), gridjs.html(statusBadge), gridjs.html(actions)];
  });

  if (window._regGrid) { window._regGrid.updateConfig({data:data}).forceRender(); return; }
  document.getElementById('reg-grid') && (window._regGrid = new gridjs.Grid({
    columns:[
      {name:'Institution',width:'22%'},{name:'Country/Region',width:'13%'},
      {name:'Type',width:'7%',sort:false},{name:'Nature',width:'12%'},
      {name:'Unit',width:'7%',sort:false},{name:'Start',width:'10%'},
      {name:'End',width:'10%'},{name:'Status',width:'10%',sort:false},
      {name:'Actions',width:'9%',sort:false}
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
  document.getElementById('view-body').innerHTML =
    '<div class="row g-3">'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Institution</div><div class="fw-semibold">'+p.inst+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Country</div><div class="fw-semibold">'+p.country+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Region</div><div class="fw-semibold">'+p.region+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Type</div><div class="fw-semibold">'+p.type+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Nature</div><div class="fw-semibold">'+p.nature+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Category</div><div class="fw-semibold">'+p.cat+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Start Date</div><div class="fw-semibold">'+p.start+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">End Date</div><div class="fw-semibold">'+p.end+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Status</div><div>'+sbadge(p.status)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Responsible Unit</div><div class="fw-semibold">'+p.unit+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">CIRL Coordinator</div><div class="fw-semibold">'+(p.coordinator||'—')+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Partner Email</div><div>'+(p.partnerEmail?'<a href="mailto:'+p.partnerEmail+'">'+p.partnerEmail+'</a>':'—')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Document Link</div><div>'+(p.docLink?'<a href="'+p.docLink+'" target="_blank">'+p.docLink+'</a>':'— Not uploaded')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Remarks</div><div>'+(p.remarks||'—')+'</div></div>'
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
function openEditModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; editingId=id;
  var toISO=function(s){var d=new Date(s);return isNaN(d)?'':d.toISOString().slice(0,10);};
  document.getElementById('e-inst').value=p.inst; document.getElementById('e-country').value=p.country;
  document.getElementById('e-region').value=p.region; document.getElementById('e-partner-email').value=p.partnerEmail||'';
  document.getElementById('e-type').value=p.type; document.getElementById('e-nature').value=p.nature;
  document.getElementById('e-cat').value=p.cat; document.getElementById('e-start').value=toISO(p.start);
  document.getElementById('e-end').value=toISO(p.end); document.getElementById('e-status').value=p.status;
  document.getElementById('e-unit').value=p.unit; document.getElementById('e-coordinator').value=p.coordinator||'';
  document.getElementById('e-doclink').value=p.docLink||''; document.getElementById('e-remarks').value=p.remarks||'';
  new bootstrap.Modal(document.getElementById('editPartnershipModal')).show();
}
function computeEditStatus(){var v=document.getElementById('e-end').value;if(!v)return;var d=Math.ceil((new Date(v)-new Date())/86400000);document.getElementById('e-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';}
function saveEdit(){
  var inst=document.getElementById('e-inst').value.trim(),end=document.getElementById('e-end').value;
  if(!inst||!end){alert('Institution name and End Date are required.');return;}
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===editingId;}); if(!p) return;
  var updates={inst:inst,country:document.getElementById('e-country').value.trim(),region:document.getElementById('e-region').value,
    partnerEmail:document.getElementById('e-partner-email').value.trim(),type:document.getElementById('e-type').value,
    nature:document.getElementById('e-nature').value,cat:document.getElementById('e-cat').value,
    start:fmt(document.getElementById('e-start').value),end:fmt(end),endYear:new Date(end).getFullYear(),
    status:document.getElementById('e-status').value,unit:document.getElementById('e-unit').value,
    coordinator:document.getElementById('e-coordinator').value.trim(),docLink:document.getElementById('e-doclink').value.trim(),
    remarks:document.getElementById('e-remarks').value.trim()};
  fetch('/api/partnerships/'+editingId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        Object.assign(p,updates);
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
  var newEnd=document.getElementById('renew-new-end').value; if(!newEnd){alert('Please set a new end date.');return;}
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===renewingId;}); if(!p) return;
  var d=Math.ceil((new Date(newEnd)-new Date())/86400000);
  var updates={end:fmt(newEnd),endYear:new Date(newEnd).getFullYear(),status:d<0?'Expired':d<=90?'Expiring Soon':'Active'};
  var rmk=document.getElementById('renew-remarks').value.trim(); if(rmk) updates.remarks=rmk;
  fetch('/api/partnerships/'+renewingId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        Object.assign(p,updates);
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

function highlight(id,on){var el=document.getElementById(id);if(!el)return;el.style.borderColor=on?'#dc2626':'';el.addEventListener('input',function(){el.style.borderColor='';},{once:true});}

function submitPartnership(){
  var inst=document.getElementById('f-inst').value.trim(),type=document.getElementById('f-type').value,
      start=document.getElementById('f-start').value,end=document.getElementById('f-end').value,
      unit=document.getElementById('f-unit').value,region=document.getElementById('f-region').value;
  if(!inst)highlight('f-inst',true);if(!type)highlight('f-type',true);
  if(!start)highlight('f-start',true);if(!end)highlight('f-end',true);if(!unit)highlight('f-unit',true);
  if(!inst||!type||!start||!end||!unit)return;
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var d=Math.ceil((new Date(end)-new Date())/86400000);
  var status=document.getElementById('f-status').value||(d<0?'Expired':d<=90?'Expiring Soon':'Active');
  var payload={inst:inst,country:document.getElementById('f-country').value.trim()||'—',
    region:region||'—',type:type,nature:document.getElementById('f-nature').value||'—',
    cat:document.getElementById('f-cat').value||'International',unit:unit,
    coordinator:document.getElementById('f-coordinator').value.trim(),
    partnerEmail:document.getElementById('f-partner-email').value.trim(),
    docLink:document.getElementById('f-doc-link').value.trim(),
    startYear:new Date(start).getFullYear(),endYear:new Date(end).getFullYear(),
    start:fmt(start),end:fmt(end),status:status,remarks:document.getElementById('f-remarks').value.trim()};
  fetch('/api/partnerships',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.success){
        partnerships.push(data.partnership);filtered=partnerships.slice();applyFilter();
        bootstrap.Modal.getInstance(document.getElementById('addPartnershipModal'))?.hide();
        showToast('"'+inst+'" added to the registry.');
      }
    }).catch(function(e){console.error(e);showToast('Error saving partnership.');});
}

// Counter animation (card stat numbers)
function initCounters() {
  document.querySelectorAll('.counter-value').forEach(function (el) {
    var target = parseInt(el.dataset.target);
    if (isNaN(target)) return;
    var start = 0, duration = 1200, fps = 60;
    var step = target / (duration / (1000 / fps));
    var timer = setInterval(function () {
      start += step;
      if (start >= target) { el.textContent = target; clearInterval(timer); }
      else el.textContent = Math.floor(start);
    }, 1000 / fps);
  });
}

// ── DOMContentLoaded ─────────────────────────────────────────────────────────
// Note: buildGrid() and initCounters() are called by the fetch().then() above
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
    dismissOcrResult();
    ocrShow('ocr-progress-wrap', false);
  });
});

