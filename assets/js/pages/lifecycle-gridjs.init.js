// ── Lifecycle Monitor – Grid.js init (now backed by real Partnership Registry data) ──

var partnerships = [];
var activeStatus = '', activeCat = '', lcGrid = null;

// Load partnerships from the same MongoDB-backed API the Registry page uses —
// Lifecycle is a monitoring view over that one source of truth, not a separate dataset.
fetch('/api/partnerships')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    partnerships = data.map(function(p) {
      var end = p.end || '';
      var expDate = new Date(end);
      var daysLeft = isNaN(expDate) ? 0 : Math.ceil((expDate - new Date()) / 86400000);
      return {
        id:     p.id,
        inst:   p.inst || p.institution || p.name || '',
        type:   p.type || '',
        cat:    p.cat || p.category || 'International',
        start:  p.start || '',
        end:    end,
        days:   daysLeft,
        status: p.status || (daysLeft < 0 ? 'Expired' : daysLeft <= 90 ? 'Expiring Soon' : 'Active')
      };
    });
    buildGrid();
    renderOverview();
    renderUrgentList();
    renderDssAlerts();
  })
  .catch(function(err) {
    console.error('Failed to load partnerships:', err);
    buildGrid();
    document.getElementById('urgent-list').innerHTML = '<li class="list-group-item px-3 py-3 text-danger fs-12">Could not load data.</li>';
  });

function daysBadgeHtml(d, s) {
    if (s === 'Expired') return '<span class="badge bg-danger-subtle text-danger">Expired</span>';
    if (d <= 14)         return '<span class="badge bg-danger">Critical (' + d + 'd)</span>';
    if (d <= 90)         return '<span class="badge bg-warning-subtle text-warning">' + d + ' days</span>';
    return '<span class="badge bg-success-subtle text-success">' + d + ' days</span>';
}

function statusBadgeHtml(s) {
    var map = { Active: 'bg-success-subtle text-success', 'Expiring Soon': 'bg-warning-subtle text-warning', Expired: 'bg-danger-subtle text-danger' };
    return '<span class="badge ' + (map[s] || 'bg-secondary-subtle text-secondary') + '">' + s + '</span>';
}

function typeBadgeHtml(t) {
    var cls = t === 'MOU' ? 'bg-info-subtle text-info' : 'bg-primary-subtle text-primary';
    return '<span class="badge ' + cls + '">' + t + '</span>';
}

function getFiltered() {
    return partnerships.filter(function (p) {
        var statusOk = !activeStatus || (activeStatus === 'Expiring' ? p.status === 'Expiring Soon' : p.status === activeStatus);
        return statusOk && (!activeCat || p.cat === activeCat);
    });
}

function buildGrid() {
    var filtered = getFiltered();
    var countEl = document.getElementById('lc-count');
    if (countEl) countEl.textContent = filtered.length + ' of ' + partnerships.length + ' agreements';

    var data = filtered.map(function (p) {
        return [
            p.inst,
            gridjs.html(typeBadgeHtml(p.type)),
            p.cat,
            p.end,
            gridjs.html(daysBadgeHtml(p.days, p.status)),
            gridjs.html(statusBadgeHtml(p.status)),
            gridjs.html((function () {
                // Renew/Edit/Delete are Administrator-only; View/Remind stay
                // available to everyone (read-only). POST/PATCH/DELETE
                // /api/partnerships enforce this server-side regardless.
                var canManage = typeof CAN_MANAGE_LIFECYCLE !== 'undefined' && CAN_MANAGE_LIFECYCLE;
                return '<div class="dropdown">'
                + '<button class="btn btn-soft-secondary btn-sm" data-bs-toggle="dropdown"><i class="ri-more-fill"></i></button>'
                + '<ul class="dropdown-menu dropdown-menu-end">'
                + (p.status === 'Expired'
                    ? (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openRenewModal(' + p.id + ')"><i class="ri-refresh-line me-2 text-muted"></i>Renew</a></li>' : '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-eye-line me-2 text-muted"></i>View</a></li>')
                    : p.days <= 90
                        ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-notification-line me-2 text-muted"></i>Remind</a></li>'
                        : '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-eye-line me-2 text-muted"></i>View</a></li>')
                + (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openEditModal(' + p.id + ')"><i class="ri-pencil-line me-2 text-muted"></i>Edit</a></li>' : '')
                + (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item text-danger" onclick="openDeleteModal(' + p.id + ')"><i class="ri-delete-bin-line me-2"></i>Delete</a></li>' : '')
                + '</ul></div>';
            })())
        ];
    });

    if (lcGrid) {
        lcGrid.updateConfig({ data: data }).forceRender();
        return;
    }

    document.getElementById('lc-grid') && (lcGrid = new gridjs.Grid({
        columns: [
            { name: 'Institution', width: '28%' },
            { name: 'Type',        width: '8%',  sort: false },
            { name: 'Category',    width: '12%' },
            { name: 'Expiry Date', width: '14%' },
            { name: 'Days Left',   width: '13%', sort: false },
            { name: 'Status',      width: '12%', sort: false },
            { name: 'Action',      width: '10%', sort: false }
        ],
        data: data,
        search: true,
        pagination: { limit: 10 },
        sort: true,
        className: {
            table:  'table table-hover align-middle mb-0',
            thead:  'table-light',
            search: 'mb-3'
        },
        language: {
            search:     { placeholder: 'Search agreements...' },
            pagination: { previous: '←', next: '→', showing: 'Showing', results: function() { return 'agreements'; } }
        }
    }).render(document.getElementById('lc-grid')));
}

function setPill(type, val, btn) {
    var group = document.getElementById('pills-' + type);
    group.querySelectorAll('.nav-link').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    if (type === 'status') activeStatus = val;
    else activeCat = val;
    buildGrid();
}

// ── Overview panel, Urgent list, DSS Smart Alerts — all computed from real data ──

function renderOverview() {
    var total = partnerships.length;
    var active = partnerships.filter(function(p) { return p.status === 'Active'; }).length;
    var expiring90 = partnerships.filter(function(p) { return p.status === 'Expiring Soon'; }).length;
    var expiring30 = partnerships.filter(function(p) { return p.status === 'Expiring Soon' && p.days <= 30; }).length;
    var expired = partnerships.filter(function(p) { return p.status === 'Expired'; }).length;
    var moa = partnerships.filter(function(p) { return p.type === 'MOA'; }).length;
    var mou = partnerships.filter(function(p) { return p.type === 'MOU'; }).length;
    var intl = partnerships.filter(function(p) { return p.cat === 'International'; }).length;
    var local = partnerships.filter(function(p) { return p.cat === 'Local'; }).length;
    var activeRate = total ? Math.round((active / total) * 100) : 0;

    function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    setText('cnt-total', total);
    setText('cnt-active', active);
    setText('cnt-expiring', expiring90);
    setText('cnt-expired', expired);
    setText('cnt-moamou', 'MOA: ' + moa + '  MOU: ' + mou);

    setText('ov-total', total);
    setText('ov-active', active);
    setText('ov-expiring30', expiring30);
    setText('ov-expiring90', expiring90);
    setText('ov-expired', expired);
    setText('ov-active-rate', activeRate + '%');
    setText('ov-moa', moa);
    setText('ov-mou', mou);
    setText('ov-intl', intl);
    setText('ov-local', local);
    setText('cnt-active-rate', activeRate + '%');

    var activeBar = document.getElementById('ov-active-bar'); if (activeBar) activeBar.style.width = activeRate + '%';
    var moaBar = document.getElementById('ov-moa-bar'); if (moaBar) moaBar.style.width = (total ? Math.round(moa / total * 100) : 0) + '%';
    var mouBar = document.getElementById('ov-mou-bar'); if (mouBar) mouBar.style.width = (total ? Math.round(mou / total * 100) : 0) + '%';
}

function renderUrgentList() {
    var urgent = partnerships
        .filter(function(p) { return p.status === 'Expiring Soon' || p.status === 'Expired'; })
        .sort(function(a, b) { return a.days - b.days; })
        .slice(0, 7);
    var ul = document.getElementById('urgent-list');
    if (!ul) return;
    if (!urgent.length) {
        ul.innerHTML = '<li class="list-group-item px-3 py-3 text-muted fs-12">No urgent agreements.</li>';
        return;
    }
    ul.innerHTML = urgent.map(function(p) {
        var dotClass = p.status === 'Expired' ? 'bg-danger' : (p.days <= 14 ? 'bg-danger' : 'bg-warning');
        var textClass = p.status === 'Expired' ? 'text-danger' : (p.days <= 14 ? 'text-danger' : 'text-warning');
        var label = p.status === 'Expired' ? 'Expired' : (p.days + ' days');
        return '<li class="list-group-item px-3 py-2"><div class="d-flex align-items-center gap-2">'
            + '<span class="badge ' + dotClass + ' rounded-circle p-1">&nbsp;</span>'
            + '<div><div class="fw-semibold fs-13">' + p.inst + '</div>'
            + '<div class="text-muted fs-12">' + p.type + ' &middot; <strong class="' + textClass + '">' + label + '</strong></div></div>'
            + '</div></li>';
    }).join('');
}

function renderDssAlerts() {
    var expiringSoon = partnerships.filter(function(p) { return p.status === 'Expiring Soon'; }).sort(function(a,b){ return a.days - b.days; });
    var expired = partnerships.filter(function(p) { return p.status === 'Expired'; });

    var actionEl = document.getElementById('dss-action-text');
    if (actionEl) {
        if (expiringSoon.length) {
            var soonest = expiringSoon[0];
            actionEl.innerHTML = '<span class="fw-semibold">Action Required:</span> '
                + soonest.inst + ' ' + soonest.type + ' expires in <strong>' + soonest.days + ' day' + (soonest.days === 1 ? '' : 's') + '</strong>. '
                + (expiringSoon.length > 1 ? (expiringSoon.length - 1) + ' other agreement' + (expiringSoon.length > 2 ? 's are' : ' is') + ' also expiring within 90 days.' : 'Consider initiating renewal.');
        } else {
            actionEl.textContent = 'No agreements are currently expiring within the next 90 days.';
        }
    }

    var reviewEl = document.getElementById('dss-review-text');
    if (reviewEl) {
        if (expired.length) {
            var mostOverdue = expired.slice().sort(function(a,b){ return a.days - b.days; })[0];
            var overdueDays = Math.abs(mostOverdue.days);
            reviewEl.innerHTML = '<span class="fw-semibold">Review Suggested:</span> '
                + mostOverdue.inst + ' ' + mostOverdue.type + ' expired ' + overdueDays + ' day' + (overdueDays === 1 ? '' : 's') + ' ago. '
                + (expired.length > 1 ? (expired.length - 1) + ' other expired agreement' + (expired.length > 2 ? 's remain' : ' remains') + ' unrenewed.' : 'Renew or archive this record.');
        } else {
            reviewEl.textContent = 'No expired agreements currently require review.';
        }
    }
}

// ── Modal Helpers ────────────────────────────────────────────────────────────

function openViewModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    document.getElementById('view-title').textContent = p.inst;
    document.getElementById('view-body').innerHTML =
        '<div class="row g-3">'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Institution</div><div class="fw-bold">' + p.inst + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Type</div><div>' + typeBadgeHtml(p.type) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Category</div><div class="fw-bold">' + p.cat + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Status</div><div>' + statusBadgeHtml(p.status) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Start Date</div><div class="fw-bold">' + p.start + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Expiry Date</div><div class="fw-bold">' + p.end + '</div></div>'
        + '<div class="col-sm-12"><div class="text-muted fs-12 text-uppercase fw-semibold">Days Remaining</div><div class="fw-bold">' + (p.status === 'Expired' ? 'None' : p.days + ' days') + '</div></div>'
        + '</div>';
    new bootstrap.Modal(document.getElementById('viewPartnershipModal')).show();
}

var editingId = null;
function openEditModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    editingId = id;
    var toISO = function(s) { var d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0,10); };
    document.getElementById('e-inst').value = p.inst;
    document.getElementById('e-type').value = p.type;
    document.getElementById('e-cat').value = p.cat;
    document.getElementById('e-expiry').value = toISO(p.end);
    document.getElementById('e-status').value = p.status;
    new bootstrap.Modal(document.getElementById('editPartnershipModal')).show();
}

function computeEditStatus() {
    var v = document.getElementById('e-expiry').value;
    if (!v) return;
    var d = Math.ceil((new Date(v) - new Date()) / 86400000);
    document.getElementById('e-status').value = d < 0 ? 'Expired' : d <= 90 ? 'Expiring Soon' : 'Active';
}

function saveEdit() {
    var inst = document.getElementById('e-inst').value.trim(), expiry = document.getElementById('e-expiry').value;
    if (!inst || !expiry) { alert('Institution and Expiry Date are required.'); return; }
    var p = partnerships.find(function(x) { return x.id === editingId; });
    if (!p) return;
    var fmt = function(v) { return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    var updates = {
        inst: inst, type: document.getElementById('e-type').value, cat: document.getElementById('e-cat').value,
        end: fmt(expiry), endYear: new Date(expiry).getFullYear(), status: document.getElementById('e-status').value
    };
    fetch('/api/partnerships/' + editingId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                p.inst = updates.inst; p.type = updates.type; p.cat = updates.cat; p.end = updates.end; p.status = updates.status;
                p.days = Math.ceil((new Date(p.end) - new Date()) / 86400000);
                bootstrap.Modal.getInstance(document.getElementById('editPartnershipModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('Agreement updated successfully.');
            }
        }).catch(function(e) { console.error(e); showToast('Error updating agreement.'); });
}

var renewingId = null;
function openRenewModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    renewingId = id;
    document.getElementById('renew-inst-name').textContent = p.inst;
    document.getElementById('renew-inst-sub').textContent = p.type + ' · Previously expired: ' + p.end;
    document.getElementById('renew-prev-expiry').value = p.end;
    document.getElementById('renew-new-expiry').value = '';
    document.getElementById('renew-status').value = '';
    new bootstrap.Modal(document.getElementById('renewPartnershipModal')).show();
}

function computeRenewStatus() {
    var v = document.getElementById('renew-new-expiry').value;
    if (!v) return;
    var d = Math.ceil((new Date(v) - new Date()) / 86400000);
    document.getElementById('renew-status').value = d < 0 ? 'Expired' : d <= 90 ? 'Expiring Soon' : 'Active';
}

function saveRenew() {
    var newEx = document.getElementById('renew-new-expiry').value;
    if (!newEx) { alert('Please set a new expiry date.'); return; }
    var p = partnerships.find(function(x) { return x.id === renewingId; });
    if (!p) return;
    var fmt = function(v) { return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    var d = Math.ceil((new Date(newEx) - new Date()) / 86400000);
    var updates = { end: fmt(newEx), endYear: new Date(newEx).getFullYear(), status: document.getElementById('renew-status').value };
    fetch('/api/partnerships/' + renewingId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                p.end = updates.end; p.status = updates.status; p.days = d;
                bootstrap.Modal.getInstance(document.getElementById('renewPartnershipModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('Agreement renewed successfully.');
            }
        }).catch(function(e) { console.error(e); showToast('Error renewing agreement.'); });
}

var deletingId = null;
function openDeleteModal(id) { deletingId = id; new bootstrap.Modal(document.getElementById('deleteRecordModal')).show(); }
function confirmDelete() {
    if (!deletingId) return;
    var idx = partnerships.findIndex(function(x) { return x.id === deletingId; });
    if (idx === -1) return;
    var name = partnerships[idx].inst;
    fetch('/api/partnerships/' + deletingId, { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                partnerships.splice(idx, 1); deletingId = null;
                bootstrap.Modal.getInstance(document.getElementById('deleteRecordModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('"' + name + '" has been removed.');
            }
        }).catch(function(e) { console.error(e); showToast('Error deleting agreement.'); });
}

var toastTimer = null;
function showToast(msg) {
    var t = document.getElementById('reg-toast');
    document.getElementById('reg-toast-msg').textContent = msg;
    t.style.display = 'flex';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.display = 'none'; }, 3500);
}

// Init on DOM ready — buildGrid()/renderOverview()/etc. are called by fetch().then() above
document.addEventListener('DOMContentLoaded', function() {});
