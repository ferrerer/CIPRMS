# CIPRMS DSS Actual Formula Audit — Comparison & Custom Report Builder (2026-10-10)

**Investigation only. No application code, database records, formulas, or UI were changed to produce this
report.** Everything below is read directly from the current working-tree source (including two small,
already-applied fixes from earlier in this session — both clearly marked as such, not presented as
pre-existing behavior). Nothing here was committed or pushed.

This report **supersedes/corrects** `docs/DSS_AUDIT_2026-10-10.md` on one point: that earlier report
asserted no percentage-difference formula existed anywhere in the codebase (its "Finding #3"). That was
wrong — a closer trace (§2.6 below) found one, in a code path that earlier pass didn't check. This report is
the more carefully verified of the two; where they disagree, trust this one.

---

## 0. The single most important architectural fact

**There are two entirely separate "comparison" code paths in this codebase, and only one of them is reachable
from the Reports & Analytics page a real Administrator or Staff account actually uses.**

| Engine | Reachable from the UI? | Evidence |
|---|---|---|
| `computeMultiComparisonReport()` (`cirl.js:5169`), driving `/api/reports/comparison/multi/{preview,pdf,excel}` | **Yes — this is "Comparison" as any real user experiences it** | `reports.ejs` calls `/api/reports/comparison/multi/preview` (line 1739) and `/multi/<format>` (line 1863); its own comment block (line 1492) names it "the existing N-way engine" |
| `computeComparisonReport()` (`cirl.js:4861`), driving `/api/reports/comparison/{preview,pdf,excel}` (no `/multi/`) | **No** | Exhaustive `grep` for `compType`, `groupA`, `totalA`, and these exact route paths across every file in `views/` returns **zero matches**. Nothing in the UI ever calls these routes. |
| The named comparison `reportType` strings inside `computeCustomReportData()` — `'Active vs Inactive'`, `'Active vs Expired'`, `'Renewed vs Non-Renewed'`, `'Custom Comparison'`, and all six `'By [Dimension]'` values | **No** | `#cr-type`'s only options are `Summary`, `Active Partnerships`, `Inactive Partnerships`, `Expired Partnerships`, `Expiring Soon` (plus hidden legacy aliases `Expiration`/`Active List`/`Expired List`/`Mid-Year`/`Yearly`/`Audit`) — confirmed by reading the actual `<option>` list, `reports.ejs:338-349`. Each Multi-Comparison config's own `reportType` `<select>` (`reports.ejs:1547-1551`) offers exactly the same five plain values. None of the comparison-named strings appear as an `<option>` anywhere. |
| Single-report grouping via the separate **Group By** dropdown (`#cr-groupby` → `groupBy=unit/country/inst/region/type/nature/cat`) | **Yes** | `reports.ejs:412-421`; read into the request at `reports.ejs:1056,1715`; inside `computeCustomReportData`, a truthy `groupBy` always lands in the explicit 3-way `['Active','Expiring Soon','Inactive']` branch (`cirl.js:3953-3965`, see §2.3) |

**Why this matters for every answer below:** the `computeComparisonReport` engine (Group A/B, absolute
difference, the percentage-difference formula in §2.6) is real, implemented code — but it is legacy/orphaned
from the UI's perspective. It predates the 2026-07 "Comparison Fully Extracted From the Builder" redesign
(`docs/SYSTEM_AUDIT_2026-07-16.md`) and the later Multi-Configuration Comparison addition, and nothing
removed it, so it still runs correctly if called directly — it's just that no button, link, or dropdown in the
current Reports & Analytics page ever calls it. The same is true for every one of the named comparison
`reportType` strings in `computeCustomReportData`. **I verify each one's formula below regardless** (the
brief asks "what does the implementation use," not "what is wired to a button"), but I label reachability
explicitly for every metric, because "implemented" and "live" are different, verified, separate facts here.

---

## 1. Architecture traced (file/function map)

| Layer | Location |
|---|---|
| Custom Report Builder engine (Preview/PDF/Excel, and the one live grouping mechanism) | `computeCustomReportData()`, `cirl.js:3817-4120` |
| Its routes | `GET /api/reports/custom/preview`, `/api/reports/partnerships/pdf`, `/api/reports/partnerships/excel` (`cirl.js:4123+`) |
| Legacy two-group Comparison engine (UI-unreachable, see §0) | `computeComparisonReport()`, `cirl.js:4861-5053` |
| Its routes (UI-unreachable) | `/api/reports/comparison/{preview,pdf,excel}` (`cirl.js:5087-5146`) |
| Its PDF/Excel renderers (where the percentage-difference formula actually lives) | `renderComparisonReportPdf()` (`cirl.js:~4490-4660`), `buildComparisonExcel()` (`cirl.js:4706+`) |
| Live Multi-Configuration Comparison engine | `computeMultiComparisonReport()`, `cirl.js:5169-5202` — explicitly reuses `computeCustomReportData()` once per configuration |
| Its routes | `/api/reports/comparison/multi/{preview,pdf,excel}` (`cirl.js:5468+`) |
| Status/lifecycle source of truth | `computeStatusFromEnd()`, `cirl.js:6372` |
| Date-range filter | `filterByDateRange()`, `cirl.js:3112` |
| Frontend — Preview table, Multi-Comparison summary table, chart | `views/administrator/reports.ejs` |
| Chart rendering | ApexCharts, `reports.ejs:1833-1845` |

**Frontend computation check (answers "is this calculated in MongoDB, JavaScript, or elsewhere"):**
`grep`ing `reports.ejs` for any arithmetic on comparison numbers (`totalA`, `pctDiff`, manual `/`, `*100`,
etc.) finds none — the chart-building code at `reports.ejs:1799-1845` only ever reads `r.count` and
`r.percentage` straight off the server's JSON response and formats/draws them (`Number(r.percentage).toFixed(1)`
is display rounding, not a calculation). **Every number is computed server-side, in plain JavaScript, operating
on a MongoDB `find()` result already in memory — not in a MongoDB aggregation pipeline, and not in the
browser.** No AI/ML anywhere in this pipeline.

---

## 2. Every metric, exactly as implemented

Status key: **Implemented** (verified in source, and I traced the exact lines) · **Implemented (not
UI-reachable)** (real code, verified, but no UI control calls it — see §0) · **Partially implemented** ·
**Not implemented** · **Unable to verify**.

### 2.1 Total partnerships — **Implemented**

- **Formula:** `docs.length`, where `docs` is the result of `db.collection('partnerships').find(filter)` after
  every active filter (category, date range, unit, agreement type, region, country, institution, status) has
  been applied.
- **DB fields:** whichever fields the active filters touch (`cat`, `unit`, `type`, `region`, `country`, `inst`,
  `status`/derived status).
- **Source:** `computeCustomReportData`, `cirl.js:3843-3862` (filter construction), `totalRecords: docs.length`
  in its return object.
- **Computed in:** JavaScript, on a plain MongoDB `find()` result (not an aggregation pipeline).

### 2.2 Partnership status classification (Active / Expiring Soon / Expired) — **Implemented**

- **Formula:**
  ```js
  function computeStatusFromEnd(endStr) {
    const end = new Date(endStr);
    if (isNaN(end)) return null;
    const daysLeft = Math.ceil((end - new Date()) / 86400000);
    if (daysLeft < 0) return 'Expired';
    if (daysLeft <= LIFECYCLE_EXPIRING_WINDOW_DAYS) return 'Expiring Soon';
    return 'Active';
  }
  ```
- **DB field used:** `end` only. Recomputed fresh on **every** report run (`computeCustomReportData`,
  `cirl.js:3908-3911`; `computeComparisonReport`, `cirl.js:4904-4908`) — a stored `status` field on the
  document is never trusted for reporting, only ever overwritten by this live recalculation.
- **Source:** `cirl.js:6372`.
- **"Inactive" is not its own status** — it is a report-level grouping label applied on top of the three real
  statuses (see 2.3/2.4). There is no fourth literal status value "Inactive" stored anywhere; it's always some
  combination of Expired (+ sometimes Expiring Soon) decided per report type.

### 2.3 Single-report grouping by dimension (the live "compare colleges/units" mechanism) — **Implemented**

This is the mechanism an actual Administrator/Staff account uses today to see a per-unit (or per-country,
per-institution, etc.) breakdown in one report: set **Group By → College / Unit** (`#cr-groupby`, value
`unit`) with the **College/Unit filter itself left blank**, so every unit present in the (otherwise filtered)
dataset gets its own row.

- **Formula, per group `v` (e.g. one College/Unit value):**
  - `Total_v` = count of docs whose dimension value is `v` (a doc with an array-valued dimension, e.g. a
    multi-unit partnership, counts once toward **each** of its values — `cirl.js:3994-4009`)
  - `Active_v` = count where `status === 'Active'`
  - `Expiring Soon_v` = count where `status === 'Expiring Soon'`
  - `Inactive_v` = count where `status === 'Expired'` (Expiring Soon is **not** folded in here, because it
    already has its own column — see §3's reconciliation note)
  - `{dimension} %` = `Active_v / Total_v × 100` (one decimal; `0.0` if `Total_v` is 0)
  - `% of Total` = `Total_v / docs.length × 100` (one decimal; `0.0` if `docs.length` is 0)
- **DB fields:** the grouping dimension's own field (`unit`, `country`, `inst`, `region`, `type`, `nature`,
  `cat`), plus `status` (derived, see 2.2).
- **Filters applied first:** category, date range, agreement type, region, country, institution, nature, and
  an explicit status filter (or the Report Type's implied one) — all of §2.1's filters, before grouping.
- **Source:** `computeCustomReportData`, `cirl.js:3953-3965` (the branch that assigns the 3-way
  `['Active','Expiring Soon','Inactive']` metric set whenever `groupBy` is set), `cirl.js:3988-4009` (grouping
  loop), `cirl.js:4049-4055` (the two percentage lines).
- **Computed in:** JavaScript.
- **Reachability:** fully UI-reachable — this is the one real "compare units" feature.

### 2.4 Named comparison `reportType` strings inside `computeCustomReportData` — **Implemented (not UI-reachable)**

`'Active vs Inactive'`, `'Active vs Expired'`, `'Renewed vs Non-Renewed'`, `'Custom Comparison'`, and the six
`'By [Dimension]'` values all exist as real, working code (`cirl.js:3932-3965`) and are exercised by
`test/reports.test.js` via direct query strings — but, per §0, no UI control ever sends these exact
`reportType` values. They use the same grouping mechanism as §2.3 but with different `metricGroups` sets
(e.g. `['Active','Inactive']` two-way instead of the three-way default). **Two confirmed bugs were found and
handled here this session** — see §4.

### 2.5 Multi-Configuration Comparison (the live "Comparison" feature) — **Implemented**

- **What it actually compares:** not a breakdown of one dataset by status — each **configuration** is its own
  independently-filtered count (optionally restricted to one College/Unit, one date range, one status, etc.),
  and the "comparison" is simply those counts and their shares of the combined total, side by side.
- **Formula, per configuration `i`:**
  - `count_i = computeCustomReportData(config_i).totalRecords` (§2.1's formula, run once per configuration,
    with that configuration's own filters)
  - `grandTotal = Σ count_i` across all configurations (2 to 5)
  - `percentage_i = grandTotal > 0 ? round(count_i / grandTotal × 100, 1 decimal) : 0`
- **DB fields:** whichever fields each configuration's own filters touch — same set as §2.1.
- **Source:** `computeMultiComparisonReport`, `cirl.js:5169-5202`.
- **Confirmed by reading the code, not assumed:** this function only reads `reportResult.totalRecords`,
  `.filters`, and `.records` off each configuration's `computeCustomReportData` result — it does **not** read
  `.comparisonData`/`.metricGroups`/`.isComparison` at all. So whenever a configuration carries a `groupBy`
  value, the resulting per-status breakdown is silently discarded — only the plain filtered count is ever
  used here.
- **Correction to an earlier draft of this report:** I originally wrote that the Multi-Comparison config card
  UI "doesn't even expose a Group By field." That was wrong, caught on a second, more careful read — each
  config card DOES render a full Group By `<select>` (`reports.ejs:1602-1613`, same seven options as the
  primary builder's own `#cr-groupby`), read into the submitted config object by `collectComparisonConfigs()`
  (`reports.ejs:1693`, `val('groupBy')`). **This is therefore a real, UI-reachable, functionally-inert
  control:** an Administrator/Staff user can select e.g. "Group By → College / Unit" on a comparison
  configuration, run the comparison, and get back the exact same plain filtered count they'd have gotten with
  Group By left at "None" — no error, no indication the selection did nothing, no per-unit breakdown. This is
  a genuine, UI-visible gap (not a backend-only/orphaned-code issue like §2.4/§2.6) — flagged here as a
  finding for Phase 4, not fixed in this pass since the brief for this report was investigation/verification
  only.
- **No Active/Expiring-Soon/Expired breakdown, no absolute difference, no percentage difference exists in this
  live feature** — only count and share-of-grand-total, per configuration.
- **Computed in:** JavaScript.

### 2.6 Absolute difference and percentage difference — **Implemented (not UI-reachable)**

This is the point where the earlier `docs/DSS_AUDIT_2026-10-10.md` was wrong, and where this report corrects
it.

- **Absolute difference:** `diff = Math.abs(totalA - totalB)`. **Source:** `computeComparisonReport`'s return
  value, `cirl.js:5047` — part of the legacy engine (§0), returned by `/api/reports/comparison/preview`, which
  nothing in the UI calls.
- **Percentage difference — found on closer inspection, NOT in `computeComparisonReport`'s return value, but
  independently recomputed in BOTH of its export renderers:**
  ```js
  const totalBoth = totalA + totalB;
  const pctA = totalBoth > 0 ? ((totalA / totalBoth) * 100).toFixed(1) : '0.0';
  const pctB = totalBoth > 0 ? ((totalB / totalBoth) * 100).toFixed(1) : '0.0';
  const pctDiff = totalBoth > 0 ? (Math.abs((totalA - totalB) / totalBoth) * 100).toFixed(1) : '0.0';
  ```
  Identical formula duplicated in `renderComparisonReportPdf` (`cirl.js:4529-4535`) and
  `buildComparisonExcel` (`cirl.js:4711-4717`) — a DRY violation (two independent copies of the same three
  lines) but not a correctness bug, since both copies are identical.
- **Important: this is NOT the "(A − B) / B × 100, baseline" formula** a reader might expect from the word
  "percentage difference." It is `|A − B| / (A + B) × 100` — the absolute gap as a share of the **combined**
  total of both groups, always non-negative, with neither group singled out as a baseline. Whether that's the
  *right* definition for CIRL's purposes is a product question, not something I can verify from the code
  alone — flagging the distinction is the most I can responsibly do here.
- **The JSON `/api/reports/comparison/preview` route does NOT return `pctA`/`pctB`/`pctDiff` at all** — only
  the PDF and Excel exports compute and show them. A hypothetical direct caller of the Preview JSON endpoint
  would see `totalA`/`totalB`/`diff` only, with no percentage figure.
- **Reachability:** none of this is reachable from the UI (§0) — this entire formula lives only inside the
  legacy engine's own PDF/Excel builders.
- **Computed in:** JavaScript.

### 2.7 Comparisons between colleges/units — **Implemented, via §2.3 and §2.5 (two different mechanisms, see above); not via §2.4/§2.6 (real code, not reachable)**

### 2.8 Targets and target achievement — **Implemented, but this is NOT part of Comparison or the Custom Report Builder**

This lives in the separate Monitoring/Dashboard "Target Tracker" feature, included here only because the
brief explicitly asked to check for it.

- **Formula:**
  - `current` = count of partnerships whose own `start` (signing) date falls inside the target's specific
    month/year — deliberately **not** the overlap-style `filterByDateRange` used by Comparison/CRB (see the
    code's own comment at `cirl.js:8273-8286` on why: a target asks "was this signed in period X," not "was
    this active during X").
  - `rawPercentage = targetCount > 0 ? round(current / targetCount × 100) : 0`
  - displayed `percentage = min(100, max(0, rawPercentage))` — clamped for display; `rawPercentage` itself is
    not clamped (so "exceeded target" is still detectable via `status`)
  - `status`: `'NOT_STARTED'` (current=0) / `'IN_PROGRESS'` (0<current<target) / `'TARGET_REACHED'`
    (current===target) / `'TARGET_EXCEEDED'` (current>target)
- **DB fields:** `start`/`startYear` (for `current`), `targetCount` (on the `targets` collection).
- **Zero-denominator guard:** `targetCount > 0 ? … : 0` — though moot in practice, since `targetCount` is
  validated as a required positive integer at creation (`validateTargetInput`, `cirl.js:8332-8356`); a target
  can't exist with a zero/missing count.
- **Source:** `computeTargetAccomplishment`, `cirl.js:8300-8326`.
- **Computed in:** JavaScript.

### 2.9 Rankings or trend analytics — **Not implemented**

Searched `cirl.js` and `reports.ejs` for `rank`/`Ranking`/`trend`/`Trend` in any comparison- or report-related
context: no such feature exists. The closest thing to a "ranking" is that `comparisonData` rows are sorted by
`Total` descending (`cirl.js:4038`, `.sort((a,b) => b.Total - a.Total)`) before being returned — a display
ordering, not a computed rank value, percentile, or trend-over-time series. There is no time-series/trend
chart anywhere in this feature.

---

## 3. Mathematics and algorithms actually used

| Technique | Where |
|---|---|
| Counting and grouping | Every metric above — `Array.filter().length` and a `groupsMap` keyed by dimension value |
| Filtering via MongoDB query | The initial `db.collection('partnerships').find(filter)` in both `computeCustomReportData` and `computeComparisonReport` — the only step that happens inside MongoDB itself; everything after is plain JS on the returned array |
| Addition/subtraction | `Total += 1` per matching doc; `diff = Math.abs(a-b)` |
| Ratios/percentages | `%` formulas throughout §2, always a plain division with an explicit `>0` guard before dividing |
| Predefined status-classification rules | `computeStatusFromEnd`'s day-count thresholds (§2.2) |
| Statistical calculations (mean, median, std-dev, regression, etc.) | **None found** — nothing beyond counts, sums, and percentages |
| Any AI/ML/predictive technique | **None found** — confirmed by reading every function named above in full; no model, no trained weights, no external ML API call, no "prediction" field on any report object |

---

## 4. Verified comparison walkthrough, with real test fixtures

Using the actual fixtures from `test/reports.test.js`'s `beforeAll` (real documents inserted into the real
MongoDB this app runs against, tagged `remarks: 'jesttest'` for cleanup — not fabricated/hypothetical data):

| Institution | Country | Unit | `end` date | Status (`computeStatusFromEnd`) |
|---|---|---|---|---|
| Jest Report Filter University | Testland | CIRL | Jan 1, 2030 | Active |
| Jest Report Filter Expired University | Testland | CIRL | Jan 1, 2015 | Expired |
| Jest Report Filter Expiring University | Testland | CIRL | ~30 days from now | Expiring Soon |

### 4.1 §2.3 mechanism (live): Group By → College/Unit, no unit filter, filtered to `country=Testland`

Request: `GET /api/reports/custom/preview?groupBy=unit&country=Testland` (equivalent to what the UI sends when
Group By = College/Unit and Country = Testland).

- All three docs share `unit=CIRL`, so there is exactly one group, `"CIRL"`.
- `Total_CIRL = 3`, `Active_CIRL = 1`, `Expiring Soon_CIRL = 1`, `Inactive_CIRL = 1` (the Expired doc only).
- Reconciliation: `1 + 1 + 1 = 3 = Total` ✓.
- `Active % = 1/3×100 = 33.3%`. `% of Total = 3/3×100 = 100.0%` (only group present).
- This exact scenario (filtered to this same Testland/CIRL fixture set) is independently asserted by the
  pre-existing test `"By College / Unit, filtered to CIRL unit and Testland: single group containing all three
  statuses reconciles"` (`test/reports.test.js`), which was passing before this session and remains passing
  after — this mechanism was never part of either confirmed bug.

### 4.2 §2.4 mechanism (real code, UI-unreachable): `reportType=Active vs Inactive`, grouped by Country

Request: `GET /api/reports/custom/preview?reportType=Active%20vs%20Inactive&compareBy=Country&country=Testland`
(only reachable by a direct, authenticated API call — no UI control sends this).

**Before this session's fix:** `metricGroups=['Active','Inactive']`, and `'Inactive'` matched only
`status==='Expired'`. Result: `Active=1, Inactive=1, Total=3` → `1+1=2 ≠ 3`. The Expiring Soon record was
counted in `Total` but in **neither** displayed column — a genuine reconciliation failure.

**After this session's fix** (`cirl.js:4023,4027` — folds Expiring Soon into Inactive only when nothing else
already tracks it separately, so the §4.1/§4.3 three-way breakdowns are untouched): `Active=1, Inactive=2,
Total=3` → `1+2=3` ✓. This also now matches what `computeComparisonReport`'s own `matchStatus('Inactive')`
has always returned for the same data (`cirl.js:4928`, 3-way: Expired + Inactive + Expiring Soon) — the
cross-feature inconsistency closed.

**Confirmed via TDD:** new tests in `test/reports.test.js` were written failing against the pre-fix code
(verified failing), then passing after the one-line conditional fix (verified passing) — see that file's
"Active vs Inactive: Active + Inactive reconciles to Total" and "...now agree on what counts as Inactive"
tests. A regression test for the untouched §4.1 behavior was added alongside it.

### 4.3 `Custom Comparison` bare default (no `customStatuses`) — confirmed double-count, fix written but NOT yet applied to `cirl.js`

Request: `GET /api/reports/custom/preview?reportType=Custom%20Comparison&country=Testland&inst=Expired`
(`inst=Expired` isolates exactly one record — the Expired fixture — via its institution name).

**Current code** (`cirl.js:3940`, unchanged as of this report): bare default is
`metricGroups=['Active','Inactive','Expired']`. Since `'Inactive'` already matches `status==='Expired'`, the
one isolated Expired record is counted in **both** the `Inactive` and `Expired` columns:
`Total=1, Active=0, Inactive=1, Expired=1` → `0+1+1=2 ≠ 1`. Confirmed double-count.

**Confirmed unreachable from the UI**, same method as §0: `grep`ing `Custom Comparison` and `customStatuses`
across every file in `views/` and `assets/js/` returns zero matches; the only places either string appears
are `cirl.js` itself, `test/reports.test.js`, and this audit's own documentation. `docs/SYSTEM_AUDIT_2026-07-16.md`
explains why — this `reportType` predates the Comparison-extraction redesign and was never re-wired to any UI
control afterward.

**Status: a fix is written (a new failing test in `test/reports.test.js`, changing the bare default to the
same genuinely-disjoint `['Active','Expiring Soon','Inactive']` three-way split already proven correct in
§4.1) but has NOT been applied to `cirl.js` yet, and the new test has NOT been run yet** — both deferred at
the end of the prior session specifically to avoid touching the shared live test database while a full test
run was still in progress, and this session's instructions were investigation-only ("do not modify any code
yet"). This is accurately reflected as **pending**, not as done.

### 4.4 Edge cases, verified against source

| Case | Where handled | Result |
|---|---|---|
| Zero denominator | `Total_v > 0 ? … : '0.0'`, `docs.length > 0 ? … : '0.0'`, `grandTotal > 0 ? … : 0`, `totalBoth > 0 ? … : '0.0'`, `targetCount > 0 ? … : 0` | Guarded everywhere a division occurs — verified by reading every formula site in §2 |
| Empty dataset | `comparisonData` → `[]`; `totalRecords`/`count` → `0` | Verified by existing passing test `"By Institution, filtered to a country with zero matches: zero-result behavior is unaffected"` |
| Duplicate partnership records | Not deduplicated anywhere in Comparison/CRB — each stored document counts once, by design; no "same partnership entered twice" detection exists in the reporting layer | Confirmed by reading the full filter→count pipeline; this is a design choice, not a bug, but it is a genuine limitation if duplicate data entry is a real-world risk |
| Overlapping statuses (a record counted in two "status family" columns) | This is exactly §4.2/§4.3's bug class — see above for what was found and what was (and wasn't yet) fixed | One instance fixed and verified; one instance fixed-but-unapplied; the live §4.1/§2.5 mechanisms were never affected |
| Date boundaries | `filterByDateRange` (`cirl.js:3112`) rejects only strictly-outside dates (`<`/`>`), so a boundary-equal date is included | Inclusive range, verified by reading the comparison operators directly |

---

## 5. Capstone-defense explanation

**"How does CIPRMS generate Decision Support Analytics without AI or Machine Learning?"**

CIPRMS's Comparison and Custom Report Builder features answer every displayed number with exactly two
operations, run in sequence, with nothing probabilistic or learned in between:

1. **A MongoDB query** (`find()`, occasionally `distinct()`) pulls the partnership records matching whatever
   filters are active — category, date range, college/unit, agreement type, region, country, institution,
   and status. This is the only step that touches the database; everything after runs on the array already
   in memory.
2. **Deterministic JavaScript arithmetic** on that array: `Array.filter().length` for counts,
   plain division with an explicit zero-guard for every percentage, and a day-count comparison
   (`end − today`) against two fixed thresholds to classify each record as Active, Expiring Soon, or Expired.
   Re-run the same query against the same data twice and you get the exact same answer both times — there is
   no training, no model weights, no confidence score, no "best guess."

**What is currently implemented and verified** (I traced the exact function, read the exact lines, and
either found or wrote a passing automated test for it): total partnership counts; the three-status
classification; the live per-unit/per-dimension grouped breakdown (§2.3/§4.1), confirmed reconciling exactly
to its total; the live Multi-Configuration Comparison's count-and-share-of-total mechanism (§2.5); the Target
Tracker's achievement percentage (§2.8); and one confirmed cross-feature inconsistency in the UI-unreachable
named-comparison code path, now fixed and test-verified (§4.2).

**What is implemented in the code but not verified as something a real user currently sees:** the entire
two-group `computeComparisonReport` engine, its absolute-difference and percentage-difference formulas
(§2.6), and every named comparison `reportType` string (§2.4) — real, traceable, correct-or-buggy-as-documented
code, but orphaned from the current UI. Anyone defending this system should be precise about this distinction:
these formulas exist and work if called, but a live demo of the Reports & Analytics page will never exercise
them through normal use.

**What is only a proposed enhancement, not implemented at all today:** nothing in this report proposes a new
formula — every formula discussed above is real, existing code. The one place a prior audit pass
(`docs/DSS_AUDIT_2026-10-10.md`, Finding #3) proposed a new percentage-difference metric turned out to be
unnecessary — that formula already exists (§2.6), just not where that pass first looked. If CIRL wants a
percentage-difference figure in the feature people actually use (Multi-Configuration Comparison), that
genuinely would be new work, since §2.5 confirms it isn't there today.

---

## 6. Summary — what CIPRMS currently computes, and how

- **Every number is a count, a sum, or a guarded ratio**, computed in plain JavaScript over the result of a
  single MongoDB filter query. No AI, no ML, no statistics beyond arithmetic, no ranking or trend analytics
  (confirmed absent, §2.9).
- **Two parallel "comparison" implementations exist.** Only the Multi-Configuration Comparison
  (count + share-of-total, per independently-filtered configuration) is reachable from the real UI. The
  older Group-A-vs-Group-B engine — with its absolute and percentage difference formulas — is real,
  correct-as-far-as-traced code that nothing in the current page calls.
- **The one genuinely live "compare colleges/units" feature** is the Custom Report Builder's Group By
  dropdown, which produces a per-unit Active/Expiring-Soon/Inactive breakdown in a single report — verified
  against real test fixtures to reconcile exactly to its total.
- **One confirmed, live-reachable-code arithmetic bug was found and fixed** this session (Active vs Inactive
  Expiring-Soon reconciliation, §4.2) — though even this lived in the UI-unreachable named-reportType path,
  not the Group By mechanism users actually touch. **One further confirmed bug** (§4.3, Custom Comparison's
  double-counting default) has a written, not-yet-applied fix, also in UI-unreachable code.
- **Genuine limitation, not a bug:** no deduplication of partnership records anywhere in this reporting layer
  — each stored document counts once, always.
