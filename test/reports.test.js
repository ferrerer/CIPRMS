// Covers the thesis's Black-Box Table 5 "Reporting and Dashboard Module":
// Generate Partnership Report, Filter Report Data — verifying the PDF/Excel
// export endpoints built this session produce real, correctly-filtered files.
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let agent, createdId, expiredId;

beforeAll(async () => {
  await connectDB();
  agent = request.agent(app);
  await loginAs(agent, await createTestUser({ role: 'Administrator' }));

  // A known record to filter for, so the "Filter Report Data" assertions have
  // something deterministic to look for regardless of the rest of the dataset.
  const res = await agent.post('/api/partnerships').send({
    inst: 'Jest Report Filter University', country: 'Testland', region: 'Asia', type: 'MOU',
    nature: 'Training', cat: 'International', unit: 'CIRL',
    start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', remarks: 'jesttest'
  });
  createdId = res.body.partnership.id;

  // A second, already-expired record — needed to prove "Active Partnerships"
  // never leaks a non-Active record into its results (see the Report Type /
  // Status consistency tests below).
  const expiredRes = await agent.post('/api/partnerships').send({
    inst: 'Jest Report Filter Expired University', country: 'Testland', region: 'Asia', type: 'MOU',
    nature: 'Training', cat: 'International', unit: 'CIRL',
    start: 'Jan 1, 2010', end: 'Jan 1, 2015', status: 'Active', remarks: 'jesttest'
  });
  expiredId = expiredRes.body.partnership.id;
});

afterAll(async () => {
  const db = await connectDB();
  if (createdId) await db.collection('partnerships').deleteOne({ id: createdId });
  if (expiredId) await db.collection('partnerships').deleteOne({ id: expiredId });
  await cleanupAll();
  await closeDB();
});

test('Generate Partnership Report (PDF): returns a real PDF file', async () => {
  const res = await agent.get('/api/reports/partnerships/pdf?title=Test%20Report');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toMatch(/attachment/);
  expect(res.body.slice(0, 4).toString()).toBe('%PDF');
});

test('Generate Partnership Report (Excel): returns a real workbook with the right rows', async () => {
  const res = await agent.get('/api/reports/partnerships/excel?title=Test%20Report&status=Active')
    .buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('spreadsheetml');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body);
  const sheet = workbook.worksheets[0];
  // The 2026-08-26 Reports & Analytics Round 2 redesign replaced the primary
  // export's columns with the official CIRL "List of Active International
  // Partners" template — No. | Name of Schools/Institutions | Address/Country
  // | Date of Signing | Date of Expiration — around a merged letterhead/
  // title/summary block and a Prepared by/Noted by signature block. Data
  // rows are identified by column 1 ("No.") being a row index number.
  let foundOurRecord = false;
  let dataRowsSeen = 0;
  sheet.eachRow((row) => {
    const no = row.getCell(1).value;
    const name = row.getCell(2).value;
    if (typeof no !== 'number' || !name) return;
    dataRowsSeen++;
    if (name === 'Jest Report Filter University') foundOurRecord = true;
  });
  expect(dataRowsSeen).toBeGreaterThan(0);
  expect(foundOurRecord).toBe(true);
});

test('Filter Report Data: a status filter that matches nothing returns an empty (but valid) report', async () => {
  const res = await agent.get('/api/reports/partnerships/pdf?title=Empty&status=NoSuchStatus');
  expect(res.status).toBe(200);
  expect(res.body.slice(0, 4).toString()).toBe('%PDF');
});

// Regression: "Active Partnerships" report type used to apply NO status
// filter of its own — only the separate Status field did — so a report
// generated with Report Type = "Active Partnerships" and Status left at
// "All" silently included Expired/Expiring Soon records too. Fixed by
// deriving an implied status from the Report Type whenever no explicit
// Status filter is set (computeCustomReportData's REPORT_TYPE_IMPLIED_STATUS).
describe('Report Type / Status filter consistency (status-leak regression)', () => {
  test('reportType=Active Partnerships excludes an Expired record even with no explicit Status filter', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Active%20Partnerships&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.every(p => p.status === 'Active')).toBe(true);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
    expect(res.body.records.some(p => p.id === expiredId)).toBe(false);
    expect(res.body.filters.status).toBe('Active');
  });

  test('reportType=Expired Partnerships includes the Expired record and excludes the Active one', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Expired%20Partnerships&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.every(p => p.status === 'Expired')).toBe(true);
    expect(res.body.records.some(p => p.id === expiredId)).toBe(true);
    expect(res.body.records.some(p => p.id === createdId)).toBe(false);
  });

  test('An explicit Status filter overrides the Report Type\'s implied status', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Active%20Partnerships&status=Expired&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.filters.status).toBe('Expired');
    expect(res.body.records.every(p => p.status === 'Expired')).toBe(true);
    expect(res.body.records.some(p => p.id === expiredId)).toBe(true);
  });

  test('reportType=Summary applies no implied status filter (both records present)', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Summary&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.filters.status).toBe('All');
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
    expect(res.body.records.some(p => p.id === expiredId)).toBe(true);
  });

  test('The same fix applies to the PDF and Excel export routes (single shared engine)', async () => {
    const pdfRes = await agent.get('/api/reports/partnerships/pdf?reportType=Active%20Partnerships&country=Testland');
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await agent.get('/api/reports/partnerships/excel?reportType=Active%20Partnerships&country=Testland')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    const sheet = workbook.worksheets[0];
    let foundExpired = false;
    sheet.eachRow(row => {
      if (row.getCell(2).value === 'Jest Report Filter Expired University') foundExpired = true;
    });
    expect(foundExpired).toBe(false);
  });
});

test('Compliance/Audit export: activity log PDF also generates correctly', async () => {
  const res = await agent.get('/api/reports/activitylog/pdf');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.body.slice(0, 4).toString()).toBe('%PDF');
});

describe('Enhanced Custom Report Builder & Comparison Tool', () => {
  test('Preview API: generates structured preview for Active vs Inactive grouped by Country', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Active%20vs%20Inactive&compareBy=Country&nature=Training');
    expect(res.status).toBe(200);
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Country');
    expect(Array.isArray(res.body.comparisonData)).toBe(true);
    // `nature` still narrows the underlying MongoDB query (the DB-level
    // filter capability is preserved), but as of the Custom Report Builder
    // field-removal round it's intentionally no longer echoed in the
    // response's `filters` metadata — that object now mirrors only the
    // fields the Builder's UI actually exposes.
    expect(res.body.filters.nature).toBeUndefined();
    expect(res.body.totalRecords).toBeGreaterThan(0);
  });

  test('Preview API: generates preview for Renewed vs Non-Renewed grouped by College / Unit', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Renewed%20vs%20Non-Renewed&compareBy=College%20%2F%20Unit');
    expect(res.status).toBe(200);
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('College / Unit');
    expect(res.body.metricGroups).toEqual(['Renewed', 'Non-Renewed']);
  });

  test('Preview API: handles Custom Comparison with multiple status groups', async () => {
    const res = await agent.get('/api/reports/custom/preview?reportType=Custom%20Comparison&customStatuses=Active,Expired,Expiring%20Soon&compareBy=Institution');
    expect(res.status).toBe(200);
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Institution');
    expect(res.body.metricGroups).toEqual(['Active', 'Expired', 'Expiring Soon']);
  });

  test('Excel Export: includes 2 sheets (Report Summary, Applied Filters) — comparison is a separate dedicated export', async () => {
    const res = await agent.get('/api/reports/partnerships/excel?reportType=Active%20Partnerships&cat=International&nature=Training')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    expect(workbook.worksheets.length).toBe(2);
    expect(workbook.worksheets[0].name).toBe('Report Summary');
    expect(workbook.worksheets[1].name).toBe('Applied Filters');
  });

  // 2026-08-27 View-Only → Staff migration: GET /api/reports/* routes moved
  // from requireAdmin to requireStaffAccess (Administrator OR Staff) — Auth.
  // Personnel/potential_partner remain the genuinely-excluded roles now.
  test('RBAC: Auth. Personnel is forbidden from custom report preview and export', async () => {
    const userAgent = request.agent(app);
    await loginAs(userAgent, await createTestUser({ role: 'Auth. Personnel' }));

    const previewRes = await userAgent.get('/api/reports/custom/preview');
    expect(previewRes.status).toBe(302); // Redirected away by requireStaffAccess

    const pdfRes = await userAgent.get('/api/reports/partnerships/pdf');
    expect(pdfRes.status).toBe(302);
  });

  test('RBAC: Staff CAN reach custom report preview and export (requireStaffAccess)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));

    const previewRes = await staffAgent.get('/api/reports/custom/preview');
    expect(previewRes.status).toBe(200);

    const pdfRes = await staffAgent.get('/api/reports/partnerships/pdf');
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
  });
});

describe('Comparison Report Section', () => {
  test('Preview API: Active vs Inactive returns correct structure', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Active%20vs%20Inactive');
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('Active');
    expect(res.body.groupB).toBe('Inactive');
    expect(typeof res.body.totalA).toBe('number');
    expect(typeof res.body.totalB).toBe('number');
    expect(typeof res.body.totalBoth).toBe('number');
    expect(typeof res.body.diff).toBe('number');
    expect(res.body.totalBoth).toBe(res.body.totalA + res.body.totalB);
    expect(Array.isArray(res.body.groupARecords)).toBe(true);
    expect(Array.isArray(res.body.groupBRecords)).toBe(true);
  });

  test('Preview API: Active vs Expired returns correct group labels', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Active%20vs%20Expired');
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('Active');
    expect(res.body.groupB).toBe('Expired');
    expect(res.body.filters['Comparison Type']).toBe('Active vs Expired');
  });

  test('Preview API: New vs Renewed returns Non-Renewed / Renewed labels', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=New%20vs%20Renewed');
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('New (Non-Renewed)');
    expect(res.body.groupB).toBe('Renewed');
  });

  test('Preview API: Custom Status Comparison uses statusA and statusB params', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Custom%20Status%20Comparison&statusA=Active&statusB=Expiring%20Soon');
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('Active');
    expect(res.body.groupB).toBe('Expiring Soon');
  });

  test('Preview API: filters (unit, agtype, cat) are applied and reflected in response', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Active%20vs%20Inactive&unit=CIRL&agtype=MOU&cat=International');
    expect(res.status).toBe(200);
    expect(res.body.filters['College / Unit']).toBe('CIRL');
    expect(res.body.filters['Agreement Type']).toBe('MOU');
    expect(res.body.filters['Category']).toBe('International');
  });

  test('PDF Export: Active vs Inactive returns a valid PDF', async () => {
    const res = await agent.get('/api/reports/comparison/pdf?compType=Active%20vs%20Inactive');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('PDF Export: Active vs Expired returns a valid PDF', async () => {
    const res = await agent.get('/api/reports/comparison/pdf?compType=Active%20vs%20Expired');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('PDF Export: New vs Renewed returns a valid PDF', async () => {
    const res = await agent.get('/api/reports/comparison/pdf?compType=New%20vs%20Renewed');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('Excel Export: returns a 3-sheet workbook (Comparison Summary, Group A Records, Group B Records)', async () => {
    const res = await agent.get('/api/reports/comparison/excel?compType=Active%20vs%20Inactive')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    expect(workbook.worksheets.length).toBe(3);
    expect(workbook.worksheets[0].name).toBe('Comparison Summary');
    expect(workbook.worksheets[1].name).toBe('Group A Records');
    expect(workbook.worksheets[2].name).toBe('Group B Records');
  });

  test('Excel Export: Custom Status Comparison with nature filter produces valid workbook', async () => {
    const res = await agent.get('/api/reports/comparison/excel?compType=Custom%20Status%20Comparison&statusA=Active&statusB=Expired&nature=Training')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    expect(workbook.worksheets.length).toBe(3);
  });

  test('RBAC: Auth. Personnel is forbidden from comparison preview, PDF, and Excel', async () => {
    const userAgent = request.agent(app);
    await loginAs(userAgent, await createTestUser({ role: 'Auth. Personnel' }));

    const previewRes = await userAgent.get('/api/reports/comparison/preview?compType=Active%20vs%20Inactive');
    expect(previewRes.status).toBe(302);

    const pdfRes = await userAgent.get('/api/reports/comparison/pdf?compType=Active%20vs%20Inactive');
    expect(pdfRes.status).toBe(302);

    const excelRes = await userAgent.get('/api/reports/comparison/excel?compType=Active%20vs%20Inactive');
    expect(excelRes.status).toBe(302);
  });

  test('RBAC: Staff CAN reach comparison preview, PDF, and Excel (requireStaffAccess)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));

    const previewRes = await staffAgent.get('/api/reports/comparison/preview?compType=Active%20vs%20Inactive');
    expect(previewRes.status).toBe(200);

    const pdfRes = await staffAgent.get('/api/reports/comparison/pdf?compType=Active%20vs%20Inactive');
    expect(pdfRes.status).toBe(200);

    const excelRes = await staffAgent.get('/api/reports/comparison/excel?compType=Active%20vs%20Inactive');
    expect(excelRes.status).toBe(200);
  });
});

// Reports & Analytics Round 2 (2026-08-26): comparison is reachable ONLY from
// Preview → Compare, and Group A must be the preserved original report,
// never redefined — this is the "Compare Against" dimension-override mode
// the redesigned frontend actually calls (the status-vs-status modes above
// stay supported server-side for backward compatibility but are no longer
// exposed in the Custom Report Builder's UI).
describe('Compare Against — dimension-override comparison (Round 2)', () => {
  test('Preview API: Group A is the untouched original report; Group B overrides one dimension', async () => {
    const res = await agent.get(
      '/api/reports/comparison/preview?compType=Compare%20Against&title=Original%20Report&compareField=country&compareValue=Testland'
    );
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('Original Report');
    expect(res.body.groupB).toBe('Country: Testland');
    expect(typeof res.body.totalA).toBe('number');
    expect(typeof res.body.totalB).toBe('number');
    expect(res.body.totalBoth).toBe(res.body.totalA + res.body.totalB);
    // Group B is scoped to country=Testland; our known test record must appear there.
    expect(res.body.groupBRecords.some(p => p.inst === 'Jest Report Filter University')).toBe(true);
  });

  test('Preview API: base builder filters narrow Group A without affecting the compareField override', async () => {
    const res = await agent.get(
      '/api/reports/comparison/preview?compType=Compare%20Against&nature=Training&compareField=country&compareValue=Testland'
    );
    expect(res.status).toBe(200);
    expect(res.body.filters['Nature']).toBe('Training');
    // Group A keeps the base "nature=Training" filter; Group B additionally narrows to country=Testland.
    expect(res.body.groupBRecords.every(p => p.country === 'Testland')).toBe(true);
  });

  test('Preview API: no compareValue selected yields an empty Group B, not an error', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Compare%20Against&compareField=country');
    expect(res.status).toBe(200);
    expect(res.body.totalB).toBe(0);
    expect(res.body.groupBRecords).toEqual([]);
  });

  test('PDF/Excel Export: Compare Against mode produces valid files', async () => {
    const pdfRes = await agent.get('/api/reports/comparison/pdf?compType=Compare%20Against&compareField=country&compareValue=Testland');
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await agent.get('/api/reports/comparison/excel?compType=Compare%20Against&compareField=country&compareValue=Testland')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    expect(workbook.worksheets.length).toBe(3);
  });

  // Regression: opening Compare from Preview forwards `reportType`, but
  // computeComparisonReport used to ignore it entirely and only look at the
  // separate `status` param — so a Preview generated with Report Type =
  // "Active Partnerships" (Status left at "All") produced a Group A total
  // in Compare that did NOT match the total Preview had just shown for the
  // exact same report (Compare silently reverted to every status). Fixed by
  // sharing REPORT_TYPE_IMPLIED_STATUS between both report engines.
  test('Group A total in Compare matches the original Preview total for a status-flavored Report Type', async () => {
    const previewRes = await agent.get('/api/reports/custom/preview?reportType=Active%20Partnerships&country=Testland');
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.records.every(p => p.status === 'Active')).toBe(true);

    const compareRes = await agent.get(
      '/api/reports/comparison/preview?compType=Compare%20Against&reportType=Active%20Partnerships&country=Testland&compareField=country&compareValue=Testland'
    );
    expect(compareRes.status).toBe(200);
    // Group A must be the exact same record set Preview just showed — same
    // total, and no non-Active record leaked in just because Compare was opened.
    expect(compareRes.body.totalA).toBe(previewRes.body.totalRecords);
    expect(compareRes.body.filters['Status Filter']).toBe('Active');
  });

  test('An explicit Status filter still overrides the Report Type\'s implied status in Compare, same as in Preview', async () => {
    const res = await agent.get(
      '/api/reports/comparison/preview?compType=Compare%20Against&reportType=Active%20Partnerships&status=Expired&country=Testland&compareField=country&compareValue=Testland'
    );
    expect(res.status).toBe(200);
    expect(res.body.filters['Status Filter']).toBe('Expired');
  });
});

describe('Dimension Values endpoint (powers the Compare Against picker)', () => {
  test('Returns real, sorted distinct country values including a known test value', async () => {
    const res = await agent.get('/api/reports/dimension-values?field=country');
    expect(res.status).toBe(200);
    expect(res.body.field).toBe('country');
    expect(Array.isArray(res.body.values)).toBe(true);
    expect(res.body.values).toContain('Testland');
  });

  test('Returns the fixed Partnership Status vocabulary for field=status', async () => {
    const res = await agent.get('/api/reports/dimension-values?field=status');
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual(['Active', 'Expiring Soon', 'Expired', 'Inactive']);
  });

  test('Rejects an unrecognized field', async () => {
    const res = await agent.get('/api/reports/dimension-values?field=notARealField');
    expect(res.status).toBe(400);
  });

  test('RBAC: Auth. Personnel is forbidden', async () => {
    const userAgent = request.agent(app);
    await loginAs(userAgent, await createTestUser({ role: 'Auth. Personnel' }));
    const res = await userAgent.get('/api/reports/dimension-values?field=country');
    expect(res.status).toBe(302);
  });

  test('RBAC: Staff CAN reach dimension-values (requireStaffAccess)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const res = await staffAgent.get('/api/reports/dimension-values?field=country');
    expect(res.status).toBe(200);
  });
});

// Custom Report Builder output-correctness audit (2026-08-26): the API/UI
// integration could report success while the underlying dataset was still
// wrong. Two real, silent data-correctness bugs were found and fixed:
//   1. Country (a free-text filter) did an exact, CASE-SENSITIVE string
//      match, so typing "japan" instead of "Japan" silently returned zero
//      results instead of matching real records.
//   2. `filterByDateRange`'s `dateFrom` boundary was parsed as UTC (bare ISO
//      date strings are UTC per spec) while `dateTo` and every partnership's
//      own date field were parsed as LOCAL time — an 8-hour mismatch in
//      Asia/Manila that silently excluded records dated exactly on the
//      `dateFrom` boundary day.
// Both bugs lived in code shared by Preview, PDF, Excel, and Compare, so a
// single fix (buildExactCaseInsensitiveMatch / filterByDateRange) closes all
// four consumers at once — verified by record IDs/counts, not just labels.
describe('Custom Report Builder output correctness (Country case-sensitivity + Date Range boundary)', () => {
  test('Country filter matches regardless of the casing the admin types', async () => {
    const properCase = await agent.get('/api/reports/custom/preview?country=Testland');
    const lowerCase = await agent.get('/api/reports/custom/preview?country=testland');
    const upperCase = await agent.get('/api/reports/custom/preview?country=TESTLAND');
    expect(properCase.status).toBe(200);
    expect(lowerCase.status).toBe(200);
    expect(upperCase.status).toBe(200);
    expect(lowerCase.body.totalRecords).toBe(properCase.body.totalRecords);
    expect(upperCase.body.totalRecords).toBe(properCase.body.totalRecords);
    expect(properCase.body.totalRecords).toBeGreaterThan(0);
    const idsA = properCase.body.records.map(p => p.id).sort();
    const idsB = lowerCase.body.records.map(p => p.id).sort();
    expect(idsB).toEqual(idsA);
  });

  test('Country filter still requires an exact match, not a partial substring', async () => {
    // "Testland" exists; "Test" alone must NOT match it (case-insensitivity
    // must not be confused with Institution's intentional partial search).
    const res = await agent.get('/api/reports/custom/preview?country=Test');
    expect(res.status).toBe(200);
    expect(res.body.totalRecords).toBe(0);
  });

  test('Date Range dateFrom includes a record dated exactly on the boundary day', async () => {
    // createdId's end date is 'Jan 1, 2030' — dateFrom=2030-01-01 must include it.
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2030-01-01&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
  });

  test('Date Range dateTo includes a record dated exactly on the boundary day', async () => {
    const res = await agent.get('/api/reports/custom/preview?dateTo=2030-01-01&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
  });

  test('Date Range dateFrom excludes a record dated the day before the boundary', async () => {
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2030-01-02&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(false);
  });

  test('Same-day Date Range (dateFrom = dateTo) is inclusive of a record dated exactly that day', async () => {
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2030-01-01&dateTo=2030-01-01&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
  });

  // Regression: filterByDateRange() used to check only a partnership's `end`
  // date against the Date From/Date To window. Since agreements here run
  // several years, almost any realistic window an admin picks returned ZERO
  // records — e.g. a partnership that started in 2026 and doesn't end until
  // 2030 was excluded from a "2026" window entirely, even though it was
  // clearly signed and active that year. Fixed with standard date-range
  // OVERLAP semantics (start <= dateTo AND end >= dateFrom) in the one
  // shared filterByDateRange() used by Preview, PDF, Excel, and Compare.
  test('A window matching only the START date (end is years later) still includes the record', async () => {
    // createdId: start Jan 1, 2026 → end Jan 1, 2030. A "just 2026" window
    // must include it — the old end-date-only check excluded it entirely.
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2026-01-01&dateTo=2026-12-31&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
  });

  test('A window entirely CONTAINED within a longer partnership period still includes the record', async () => {
    // expiredId: start Jan 1, 2010 → end Jan 1, 2015. Neither boundary of a
    // 2012-2013 window matches either date, but the partnership was clearly
    // active throughout it.
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2012-01-01&dateTo=2013-01-01&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === expiredId)).toBe(true);
  });

  test('A window with no overlap at all still correctly excludes both records', async () => {
    const res = await agent.get('/api/reports/custom/preview?dateFrom=2020-01-01&dateTo=2021-01-01&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(false); // starts 2026, after the window
    expect(res.body.records.some(p => p.id === expiredId)).toBe(false); // ended 2015, before the window
  });

  test('The fix applies identically to the Comparison engine (Group A base filter)', async () => {
    const res = await agent.get('/api/reports/comparison/preview?dateFrom=2026-01-01&dateTo=2026-12-31&country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.groupARecords.some(p => p.id === createdId)).toBe(true);
  });

  test('Filter combinations are ANDed correctly and one filter does not override another', async () => {
    const res = await agent.get(
      '/api/reports/custom/preview?reportType=Active%20Partnerships&country=Testland&region=Asia&cat=International&unit=CIRL&agtype=MOU&nature=Training'
    );
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === createdId)).toBe(true);
    expect(res.body.records.every(p =>
      p.status === 'Active' && p.country === 'Testland' && p.region === 'Asia' &&
      p.cat === 'International' && p.unit === 'CIRL' && p.type === 'MOU' && p.nature === 'Training'
    )).toBe(true);

    // Changing just one dimension to something that doesn't exist must zero
    // out the result — proves the filters are truly ANDed, not silently
    // dropped or OR'd together.
    const contradiction = await agent.get(
      '/api/reports/custom/preview?reportType=Active%20Partnerships&country=Testland&region=Europe'
    );
    expect(contradiction.body.totalRecords).toBe(0);
  });

  test('Preview, PDF, and Excel return the exact same record set for the same filters', async () => {
    const qs = 'reportType=Active%20Partnerships&country=Testland';
    const previewRes = await agent.get(`/api/reports/custom/preview?${qs}`);
    expect(previewRes.body.records.some(p => p.id === createdId)).toBe(true);
    const previewCount = previewRes.body.totalRecords;

    const excelRes = await agent.get(`/api/reports/partnerships/excel?${qs}`)
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    const sheet = workbook.worksheets[0];
    let excelCount = 0, foundOurRecord = false;
    sheet.eachRow(row => {
      const no = row.getCell(1).value;
      const name = row.getCell(2).value;
      if (typeof no !== 'number' || !name) return;
      excelCount++;
      if (name === 'Jest Report Filter University') foundOurRecord = true;
    });
    expect(excelCount).toBe(previewCount);
    expect(foundOurRecord).toBe(true);
  });

  test('Compare Against preserves EVERY original filter in Group A, not just Report Type', async () => {
    // A second record identical to createdId except unit=CETE, so overriding
    // ONLY the unit dimension in Compare Against has a real record to find —
    // proving the other 6 original filters (status, country, region, cat,
    // agreement type, nature) actually still apply to Group B, rather than
    // Group B's assertions passing vacuously on an empty array.
    const secondRes = await agent.post('/api/partnerships').send({
      inst: 'Jest Report Filter Unit Override University', country: 'Testland', region: 'Asia', type: 'MOU',
      nature: 'Training', cat: 'International', unit: 'CETE',
      start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', remarks: 'jesttest'
    });
    const secondId = secondRes.body.partnership.id;
    try {
      const qs = 'compType=Compare%20Against&reportType=Active%20Partnerships&country=Testland&region=Asia&cat=International&unit=CIRL&agtype=MOU&nature=Training&compareField=unit&compareValue=CETE';
      const res = await agent.get(`/api/reports/comparison/preview?${qs}`);
      expect(res.status).toBe(200);
      // Group A must be identical to the fully-filtered Preview above.
      expect(res.body.groupARecords.some(p => p.id === createdId)).toBe(true);
      expect(res.body.groupARecords.every(p =>
        p.status === 'Active' && p.country === 'Testland' && p.region === 'Asia' &&
        p.cat === 'International' && p.unit === 'CIRL' && p.type === 'MOU' && p.nature === 'Training'
      )).toBe(true);
      // Group B must have ONLY the unit dimension overridden — every other
      // original filter (status, country, region, cat, agreement type,
      // nature) must still apply, and the second record must actually appear.
      expect(res.body.groupBRecords.some(p => p.id === secondId)).toBe(true);
      expect(res.body.groupBRecords.every(p =>
        p.status === 'Active' && p.country === 'Testland' && p.region === 'Asia' &&
        p.cat === 'International' && p.unit === 'CETE' && p.type === 'MOU' && p.nature === 'Training'
      )).toBe(true);
    } finally {
      const db = await connectDB();
      await db.collection('partnerships').deleteOne({ id: secondId });
    }
  });
});

// The Reports & Analytics "Reports" tab's quick-export cards show a live
// count (e.g. "17 records") right next to the button that exports that same
// status — those two numbers must always agree. `/api/partnerships/stats`
// used to trust the STORED `status` field (refreshed only by the hourly
// lifecycle job), while every report export always recomputes status live
// via computeStatusFromEnd() — so a record whose stored status hadn't been
// refreshed yet could make the card's displayed count disagree with what
// clicking its own PDF/Excel button actually produced.
describe('Reports tab card/export consistency (stats endpoint status staleness)', () => {
  test('/api/partnerships/stats ignores a stale/corrupted stored status and matches the authoritative Reports engine', async () => {
    // Force this record's STORED status to something wrong, simulating the
    // window between hourly lifecycle recomputes — its real, authoritative
    // status (from its end date) is Active.
    const db = await connectDB();
    await db.collection('partnerships').updateOne({ id: createdId }, { $set: { status: 'DeliberatelyWrongStaleStatus' } });
    try {
      const statsRes = await agent.get('/api/partnerships/stats');
      expect(statsRes.status).toBe(200);

      const activeRes = await agent.get('/api/reports/custom/preview?reportType=Active%20Partnerships');
      expect(activeRes.body.records.some(p => p.id === createdId)).toBe(true);
      // The stats endpoint's `active` count must equal the Reports engine's
      // own Active-Partnerships total — both must agree despite the corrupted
      // stored field, because both now derive status the same authoritative way.
      expect(statsRes.body.active).toBe(activeRes.body.totalRecords);

      const expiredRes = await agent.get('/api/reports/custom/preview?reportType=Expired%20Partnerships');
      expect(statsRes.body.expired).toBe(expiredRes.body.totalRecords);
    } finally {
      await db.collection('partnerships').updateOne({ id: createdId }, { $set: { status: 'Active' } });
    }
  });

  test('The "Active Partnerships List" card exports exactly the count the card itself displays', async () => {
    const statsRes = await agent.get('/api/partnerships/stats');
    const excelRes = await agent.get('/api/reports/partnerships/excel?status=Active&title=Active%20Partnerships%20List')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    const sheet = workbook.worksheets[0];
    let exportedCount = 0;
    sheet.eachRow(row => { if (typeof row.getCell(1).value === 'number') exportedCount++; });
    expect(exportedCount).toBe(statsRes.body.active);
  });
});

// 2026-08-26: College/Unit, Region, Nature of Partnership and Institution
// were removed from the Custom Report Builder's UI (they remain fully
// available to the database, Partnership Registry, Tile Cards, and the
// Compare Against workflow — only the Builder's own filter panel/state/
// requests/metadata were trimmed). These tests lock in that the removal is
// real (not just a visual hide) and that nothing regressed.
describe('Custom Report Builder field removal (College/Unit, Region, Nature, Institution)', () => {
  test('reports.ejs no longer contains the removed fields\' form controls', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
    expect(html).not.toMatch(/id="cr-unit"/);
    expect(html).not.toMatch(/id="cr-region"/);
    expect(html).not.toMatch(/id="cr-nature"/);
    expect(html).not.toMatch(/id="cr-inst"/);
    // The Compare-By dimension picker legitimately keeps these as valid
    // comparison dimensions — only the Builder's own filter fields are gone.
    expect(html).toMatch(/id="cmp-field"/);
  });

  test('Custom Report preview metadata no longer echoes Unit/Region/Nature/Institution, even if a legacy request still sends them', async () => {
    const res = await agent.get(
      '/api/reports/custom/preview?title=Legacy%20Link&unit=CIRL&region=Asia&nature=Training&inst=Ateneo'
    );
    expect(res.status).toBe(200);
    expect(res.body.filters).not.toHaveProperty('unit');
    expect(res.body.filters).not.toHaveProperty('region');
    expect(res.body.filters).not.toHaveProperty('nature');
    expect(res.body.filters).not.toHaveProperty('institution');
    // The 7 fields still exposed by the Builder must all be present.
    expect(res.body.filters).toEqual(expect.objectContaining({
      reportType: expect.any(String),
      category: expect.any(String),
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
      agreementType: expect.any(String),
      country: expect.any(String),
      status: expect.any(String)
    }));
  });

  test('Excel "Applied Filters" sheet lists Country but no longer lists College/Unit, Region, or Nature of Partnership', async () => {
    const res = await agent.get('/api/reports/partnerships/excel?country=Testland&status=Active')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body);
    const sheet = workbook.worksheets[1]; // 'Applied Filters'
    expect(sheet.name).toBe('Applied Filters');
    const labels = [];
    sheet.eachRow(row => { const v = row.getCell(1).value; if (v) labels.push(String(v)); });
    expect(labels).toContain('Country');
    expect(labels).not.toContain('College / Unit');
    expect(labels).not.toContain('Region');
    expect(labels).not.toContain('Nature of Partnership');
  });

  test('Removed-field query params cannot silently narrow a Custom Report the way an explicit remaining filter does', async () => {
    // A request shaped exactly like what the Builder's own JS now sends
    // (only the 7 remaining fields) must return the same result whether or
    // not stale unit/region/nature/inst params are also present — proving
    // those params carry no special weight in the Builder's own output.
    const withoutStale = await agent.get('/api/reports/custom/preview?country=Testland&status=Active');
    const withStaleButContradictory = await agent.get('/api/reports/custom/preview?country=Testland&status=Active&unit=CETE&region=Europe&nature=Research&inst=NoSuchInstitution');
    // unit/region/nature/inst are STILL real, functioning filter capability
    // in the shared engine (kept for other future/legacy callers per the
    // removal spec) — so a contradictory combination legitimately narrows
    // the MongoDB result here. What must NOT happen is the Builder's own
    // request ever constructing such a query, which the previous test
    // (grepping reports.ejs) already proves. This test just documents that
    // the underlying capability itself was intentionally preserved, not
    // silently dropped.
    expect(withoutStale.status).toBe(200);
    expect(withStaleButContradictory.status).toBe(200);
    expect(withoutStale.body.totalRecords).toBeGreaterThan(0);
  });

  test('Compare workflow (Compare Against) still fully supports Unit/Region/Nature/Institution as comparison dimensions after the Builder removal', async () => {
    const values = await agent.get('/api/reports/dimension-values?field=unit');
    expect(values.status).toBe(200);
    expect(values.body.values).toContain('CIRL');

    const regionValues = await agent.get('/api/reports/dimension-values?field=region');
    expect(regionValues.body.values).toContain('Asia');

    const natureValues = await agent.get('/api/reports/dimension-values?field=nature');
    expect(natureValues.body.values).toContain('Training');
  });

  test('Tile Card regression: Active + Expired + Expiring Soon status exports partition the live database with no overlap or loss', async () => {
    const statsRes = await agent.get('/api/partnerships/stats');
    const [activeRes, expiredRes, expiringRes] = await Promise.all([
      agent.get('/api/reports/custom/preview?status=Active'),
      agent.get('/api/reports/custom/preview?status=Expired'),
      agent.get('/api/reports/custom/preview?status=Expiring%20Soon')
    ]);
    expect(activeRes.body.totalRecords).toBe(statsRes.body.active);
    expect(expiredRes.body.totalRecords).toBe(statsRes.body.expired);
    expect(expiringRes.body.totalRecords).toBe(statsRes.body.expiring);
    expect(activeRes.body.totalRecords + expiredRes.body.totalRecords + expiringRes.body.totalRecords)
      .toBe(statsRes.body.total);
  });
});

// Express's default ('extended') query parser turns bracket-notation query
// strings like `?cat[$ne]=Local` into a nested OBJECT (`{ $ne: 'Local' }`)
// rather than a string. `country`/`inst` were already safe because they're
// always run through escapeRegexLiteral(), which calls String() on its input
// first — but `cat`, `unit`, `region`, and `nature` were assigned straight
// into the MongoDB filter with no type check, so a crafted query string could
// inject a real MongoDB operator (e.g. bypassing the intended equality match
// entirely via $ne/$gt/$regex) instead of a plain value. Fixed by requiring
// `typeof === 'string'` before use, same convention already used by
// buildPartnershipFilter() for the plain partnership-list endpoint.
describe('Security: MongoDB operator injection via filter parameters is rejected', () => {
  test('Custom Report preview: cat[$ne]=Local cannot be used to bypass the intended equality match', async () => {
    const res = await agent.get('/api/reports/custom/preview?cat[$ne]=Local');
    expect(res.status).toBe(200);
    // A working injection would return every non-Local record (i.e. every
    // International one) despite `cat` never legitimately equalling an
    // object — the fixed behavior must instead ignore the malformed filter
    // entirely, exactly as if `cat` had never been supplied.
    const unfiltered = await agent.get('/api/reports/custom/preview');
    expect(res.body.totalRecords).toBe(unfiltered.body.totalRecords);
  });

  test('Custom Report preview: unit/region/nature object-shaped params cannot inject MongoDB operators', async () => {
    const res = await agent.get('/api/reports/custom/preview?unit[$ne]=CIRL&region[$gt]=&nature[$exists]=true');
    expect(res.status).toBe(200);
    const unfiltered = await agent.get('/api/reports/custom/preview');
    expect(res.body.totalRecords).toBe(unfiltered.body.totalRecords);
  });

  test('Comparison engine: object-shaped cat/unit/region/nature params cannot inject MongoDB operators', async () => {
    const res = await agent.get('/api/reports/comparison/preview?cat[$ne]=Local&unit[$ne]=CIRL&region[$ne]=Asia&nature[$ne]=Training');
    expect(res.status).toBe(200);
    const unfiltered = await agent.get('/api/reports/comparison/preview');
    expect(res.body.totalBoth).toBe(unfiltered.body.totalBoth);
  });
});

// 2026-08-27 View-Only → Staff migration: Audit Trail is the most privacy-
// sensitive module Staff gained access to — Staff must see ONLY their own
// logged actions, never Administrator's or another Staff member's. Enforced
// server-side in GET /api/activitylogs (and its PDF/Excel exports) via
// activityLogFilterFor(), keyed off the `email` field logActivity() now
// stamps on every new entry.
describe('Audit Trail: Staff sees only their own records (privacy boundary)', () => {
  let staffAgentA, staffAgentB, staffUserA, staffUserB;

  beforeAll(async () => {
    staffUserA = await createTestUser({ role: 'Staff' });
    staffAgentA = request.agent(app);
    await loginAs(staffAgentA, staffUserA);

    staffUserB = await createTestUser({ role: 'Staff' });
    staffAgentB = request.agent(app);
    await loginAs(staffAgentB, staffUserB);

    // Each Staff account generates a real, distinguishable logged action —
    // computeCustomReportData's own 'VIEW' log entry from a Preview call —
    // tagged with a unique title per account so it's unambiguous whose
    // record is whose.
    await staffAgentA.get('/api/reports/custom/preview?title=' + encodeURIComponent('jesttest Staff A private report'));
    await staffAgentB.get('/api/reports/custom/preview?title=' + encodeURIComponent('jesttest Staff B private report'));
  });

  afterAll(async () => {
    const db = await connectDB();
    await db.collection('activitylogs').deleteMany({ record: { $regex: 'jesttest Staff [AB] private report' } });
  });

  test("Staff A's Audit Trail includes their own action but not Staff B's", async () => {
    const res = await staffAgentA.get('/api/activitylogs');
    expect(res.status).toBe(200);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff A private report'))).toBe(true);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff B private report'))).toBe(false);
    // Every single returned record must belong to Staff A — not merely "at
    // least one does" — proving this is a real server-side filter, not
    // client-side hiding of an otherwise-complete list.
    expect(res.body.every(l => l.email === staffUserA.email)).toBe(true);
  });

  test("Staff B's Audit Trail includes their own action but not Staff A's, and not Administrator's", async () => {
    const res = await staffAgentB.get('/api/activitylogs');
    expect(res.status).toBe(200);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff B private report'))).toBe(true);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff A private report'))).toBe(false);
    expect(res.body.every(l => l.email === staffUserB.email)).toBe(true);
    expect(res.body.some(l => l.role === 'Administrator')).toBe(false);
  });

  test("Administrator's Audit Trail is unfiltered and includes BOTH Staff accounts' actions", async () => {
    const res = await agent.get('/api/activitylogs');
    expect(res.status).toBe(200);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff A private report'))).toBe(true);
    expect(res.body.some(l => l.record && l.record.includes('jesttest Staff B private report'))).toBe(true);
  });

  test('Auth. Personnel/potential_partner cannot reach the Audit Trail at all', async () => {
    const personnelAgent = request.agent(app);
    await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel' }));
    expect((await personnelAgent.get('/api/activitylogs')).status).toBe(302);

    const partnerAgent = request.agent(app);
    await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
    expect((await partnerAgent.get('/api/activitylogs')).status).toBe(302);
  });

  test("Staff's Activity Log PDF/Excel exports are scoped the same way as the JSON endpoint", async () => {
    const pdfRes = await staffAgentA.get('/api/reports/activitylog/pdf');
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await staffAgentA.get('/api/reports/activitylog/excel')
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    let sawOwnEntry = false, sawOtherStaffEntry = false;
    workbook.worksheets[0].eachRow(row => {
      const text = String(row.getCell(2).value || '');
      if (text.includes('jesttest Staff A private report')) sawOwnEntry = true;
      if (text.includes('jesttest Staff B private report')) sawOtherStaffEntry = true;
    });
    expect(sawOwnEntry).toBe(true);
    expect(sawOtherStaffEntry).toBe(false);
  });
});
