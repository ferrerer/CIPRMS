// Covers the thesis's Black-Box Table 5 "Reporting and Dashboard Module":
// Generate Partnership Report, Filter Report Data — verifying the PDF/Excel
// export endpoints built this session produce real, correctly-filtered files.
const request = require('supertest');
const ExcelJS = require('exceljs');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let agent, createdId, expiredId, expiringSoonId;

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

  // A third record ending 30 days out (inside computeStatusFromEnd's
  // Expiring Soon window) — needed by the "By [Dimension]" grouped-report
  // reconciliation tests below, since the Active/Expired pair above alone
  // could never expose the "Expiring Soon counted in Total but in neither
  // metric column" defect.
  const expiringEnd = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const expiringSoonRes = await agent.post('/api/partnerships').send({
    inst: 'Jest Report Filter Expiring University', country: 'Testland', region: 'Asia', type: 'MOU',
    nature: 'Training', cat: 'International', unit: 'CIRL',
    start: 'Jan 1, 2024', end: expiringEnd, status: 'Active', remarks: 'jesttest'
  });
  expiringSoonId = expiringSoonRes.body.partnership.id;
});

afterAll(async () => {
  const db = await connectDB();
  if (createdId) await db.collection('partnerships').deleteOne({ id: createdId });
  if (expiredId) await db.collection('partnerships').deleteOne({ id: expiredId });
  if (expiringSoonId) await db.collection('partnerships').deleteOne({ id: expiringSoonId });
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

  // Regression for the "By [Dimension]" reconciliation bug: these six grouped
  // report types used to fall through to the generic ['Active','Inactive']
  // default, whose 'Inactive' matcher never counted "Expiring Soon" — so a
  // group's Active + Inactive columns could sum to less than Total. Fixed by
  // giving these report types an explicit ['Active','Expiring Soon','Inactive']
  // breakdown (computeCustomReportData, the branch right below the Custom
  // Comparison one above).
  describe('"By [Dimension]" grouped report reconciliation (Active + Expiring Soon + Inactive = Total)', () => {
    const dimensionReportTypes = [
      'By Institution', 'By College / Unit', 'By Country',
      'By Region', 'By Agreement Type', 'By Nature of Partnership'
    ];

    test.each(dimensionReportTypes)('%s: every group has an explicit 3-way breakdown that sums to Total', async (reportType) => {
      const res = await agent.get('/api/reports/custom/preview?reportType=' + encodeURIComponent(reportType));
      expect(res.status).toBe(200);
      expect(res.body.isComparison).toBe(true);
      expect(res.body.metricGroups).toEqual(['Active', 'Expiring Soon', 'Inactive']);
      expect(res.body.comparisonData.length).toBeGreaterThan(0);
      res.body.comparisonData.forEach((row) => {
        expect(row.Active + row['Expiring Soon'] + row.Inactive).toBe(row.Total);
      });
    });

    // Our three Testland/CIRL fixtures (one Active, one Expired, one Expiring
    // Soon) isolate a single "Testland" group containing exactly one status
    // group with no Expired), and a single "CIRL" group (containing all three
    // statuses at once) — covering both "a group with no Expiring Soon" and
    // "a group containing Active + Expiring Soon + Expired" from one filter.
    test('By Country, filtered to Testland: reconciles with all three metrics present in one group', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=By%20Country&country=Testland');
      expect(res.status).toBe(200);
      const row = res.body.comparisonData.find(r => r.group === 'Testland');
      expect(row).toBeDefined();
      expect(row.Active).toBe(1);
      expect(row['Expiring Soon']).toBe(1);
      expect(row.Inactive).toBe(1);
      expect(row.Total).toBe(3);
      expect(row.Active + row['Expiring Soon'] + row.Inactive).toBe(row.Total);
    });

    test('By College / Unit, filtered to CIRL unit and Testland: single group containing all three statuses reconciles', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=By%20College%20%2F%20Unit&country=Testland&unit=CIRL');
      expect(res.status).toBe(200);
      expect(res.body.comparisonData.length).toBe(1);
      const row = res.body.comparisonData[0];
      expect(row.group).toBe('CIRL');
      expect(row.Active + row['Expiring Soon'] + row.Inactive).toBe(row.Total);
      expect(row.Total).toBe(3);
    });

    test('By Region, filtered to a status of only Active: group containing only one status still reconciles', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=By%20Region&country=Testland&status=Active');
      expect(res.status).toBe(200);
      const row = res.body.comparisonData.find(r => r.group === 'Asia');
      expect(row).toBeDefined();
      expect(row.Active).toBe(1);
      expect(row['Expiring Soon']).toBe(0);
      expect(row.Inactive).toBe(0);
      expect(row.Total).toBe(1);
    });

    test('By Institution, filtered to a country with zero matches: zero-result behavior is unaffected', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=By%20Institution&country=NoSuchCountryZZ');
      expect(res.status).toBe(200);
      expect(res.body.isComparison).toBe(true);
      expect(res.body.comparisonData).toEqual([]);
      expect(res.body.totalRecords).toBe(0);
    });

    test('Filtered grouped report (By Nature of Partnership + unit + agreement type combo) still reconciles', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=By%20Nature%20of%20Partnership&country=Testland&unit=CIRL&agtype=MOU');
      expect(res.status).toBe(200);
      expect(res.body.comparisonData.length).toBeGreaterThan(0);
      res.body.comparisonData.forEach((row) => {
        expect(row.Active + row['Expiring Soon'] + row.Inactive).toBe(row.Total);
      });
    });

    // Explicit non-regression check for the comparison report the fix must
    // NOT touch: 'Active vs Inactive' still uses the original 2-way default.
    test('Active vs Inactive comparison report is unaffected by the grouped-report fix', async () => {
      const res = await agent.get('/api/reports/custom/preview?reportType=Active%20vs%20Inactive&compareBy=Country');
      expect(res.status).toBe(200);
      expect(res.body.metricGroups).toEqual(['Active', 'Inactive']);
    });
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
    // unit is now stored as an array (2026-09-03 multi-unit combobox) even
    // when a plain string was sent, so membership rather than equality.
    expect(res.body.records.every(p =>
      p.status === 'Active' && p.country === 'Testland' && p.region === 'Asia' &&
      p.cat === 'International' && (Array.isArray(p.unit) ? p.unit.includes('CIRL') : p.unit === 'CIRL') &&
      p.type === 'MOU' && p.nature === 'Training'
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
        p.cat === 'International' && (Array.isArray(p.unit) ? p.unit.includes('CIRL') : p.unit === 'CIRL') &&
        p.type === 'MOU' && p.nature === 'Training'
      )).toBe(true);
      // Group B must have ONLY the unit dimension overridden — every other
      // original filter (status, country, region, cat, agreement type,
      // nature) must still apply, and the second record must actually appear.
      expect(res.body.groupBRecords.some(p => p.id === secondId)).toBe(true);
      expect(res.body.groupBRecords.every(p =>
        p.status === 'Active' && p.country === 'Testland' && p.region === 'Asia' &&
        p.cat === 'International' && (Array.isArray(p.unit) ? p.unit.includes('CETE') : p.unit === 'CETE') &&
        p.type === 'MOU' && p.nature === 'Training'
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
// requests/metadata were trimmed).
//
// 2026-09-04: College/Unit was RE-ADDED as a real, working Builder filter
// (Responsible Unit can now be multi-valued, so Reports needed to filter on
// array membership) — Region, Nature of Partnership and Institution remain
// removed. These tests now lock in the College/Unit re-add and confirm the
// other three fields are still genuinely absent, not just visually hidden.
describe('Custom Report Builder field removal (Region, Nature, Institution) / re-add (College Unit)', () => {
  test('reports.ejs has a working College/Unit control but still no Region/Nature/Institution controls', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
    expect(html).toMatch(/id="cr-unit"/);
    expect(html).not.toMatch(/id="cr-region"/);
    expect(html).not.toMatch(/id="cr-nature"/);
    expect(html).not.toMatch(/id="cr-inst"/);
    // 2026-09-18: the old single-dimension "Compare By"/"Compare Against"
    // picker (#cmp-field/#cmp-value) was replaced by the multi-configuration
    // comparison builder — each configuration gets its own dynamically
    // generated filter panel (cmpcfg-{id}-*), so there is no longer a single
    // static #cmp-field element to assert on. The Builder's own filter
    // fields (cr-unit present, cr-region/cr-nature/cr-inst absent) are
    // unaffected by that change and still verified above.
    expect(html).toMatch(/id="cmp-configs-list"/);
    expect(html).toMatch(/addComparisonConfig/);
  });

  test('Custom Report preview metadata echoes Unit but still omits Region/Nature/Institution, even if a legacy request sends them', async () => {
    const res = await agent.get(
      '/api/reports/custom/preview?title=Legacy%20Link&unit=CIRL&region=Asia&nature=Training&inst=Ateneo'
    );
    expect(res.status).toBe(200);
    expect(res.body.filters.unit).toBe('CIRL');
    expect(res.body.filters).not.toHaveProperty('region');
    expect(res.body.filters).not.toHaveProperty('nature');
    expect(res.body.filters).not.toHaveProperty('institution');
    // The 8 fields now exposed by the Builder must all be present.
    expect(res.body.filters).toEqual(expect.objectContaining({
      reportType: expect.any(String),
      category: expect.any(String),
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
      unit: expect.any(String),
      agreementType: expect.any(String),
      country: expect.any(String),
      status: expect.any(String)
    }));
  });

  test('Custom Report preview metadata defaults Unit to "All" when no unit filter is given', async () => {
    const res = await agent.get('/api/reports/custom/preview?country=Testland');
    expect(res.status).toBe(200);
    expect(res.body.filters.unit).toBe('All');
  });

  test('Excel "Applied Filters" sheet lists Country and College/Unit but not Region or Nature of Partnership', async () => {
    const res = await agent.get('/api/reports/partnerships/excel?country=Testland&status=Active&unit=CIRL')
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
    const rows = {};
    sheet.eachRow(row => {
      const label = row.getCell(1).value;
      const value = row.getCell(2).value;
      if (label) rows[String(label)] = value;
    });
    expect(rows['Country']).toBe('Testland');
    expect(rows['College / Unit']).toBe('CIRL');
    expect(Object.keys(rows)).not.toContain('Region');
    expect(Object.keys(rows)).not.toContain('Nature of Partnership');
  });

  test('Removed-field (region/nature/inst) query params cannot silently narrow a Custom Report the way an explicit remaining filter does', async () => {
    // A request shaped exactly like what the Builder's own JS now sends
    // (only the 8 remaining fields) must return the same result whether or
    // not stale region/nature/inst params are also present — proving those
    // params carry no special weight in the Builder's own output. `unit` is
    // deliberately excluded from this "stale" set now that it's a real,
    // intentional Builder field (see the College/Unit describe block below).
    const withoutStale = await agent.get('/api/reports/custom/preview?country=Testland&status=Active');
    const withStaleButContradictory = await agent.get('/api/reports/custom/preview?country=Testland&status=Active&region=Europe&nature=Research&inst=NoSuchInstitution');
    // region/nature/inst are STILL real, functioning filter capability in
    // the shared engine (kept for other future/legacy callers per the
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

// 2026-09-04: College/Unit re-add — Responsible Unit can now hold MULTIPLE
// values (e.g. unit: ["CCS", "CIRL"]), so the Custom Report Builder's new
// College/Unit filter must match by array membership, not exact equality,
// while staying backward-compatible with legacy documents where `unit` is
// still a plain string. These tests exercise every unit in
// VALID_PARTNERSHIP_UNITS, "All Units", combined filters, and Preview/PDF/
// Excel consistency — not just that the dropdown exists.
describe('College / Unit filter — real, array-aware Custom Report Builder filter', () => {
  let multiUnitId, ceteOnlyId, legacyStringUnitId;

  beforeAll(async () => {
    // A partnership responsible to BOTH CCS and CIRL — the exact scenario
    // the spec calls out: selecting either unit alone must include it.
    const multiRes = await agent.post('/api/partnerships').send({
      inst: 'Jest Multi-Unit University', country: 'UnitTestland', region: 'Asia', type: 'MOA',
      nature: 'Research', cat: 'Local', unit: ['CCS', 'CIRL'],
      start: 'Jun 1, 2026', end: 'Jun 1, 2028', status: 'Active', remarks: 'jesttest'
    });
    multiUnitId = multiRes.body.partnership.id;

    // A single-unit (CETE-only) partnership — proves selecting CCS/CIRL does
    // NOT accidentally pull in a record that has neither.
    const ceteRes = await agent.post('/api/partnerships').send({
      inst: 'Jest CETE-Only University', country: 'UnitTestland', region: 'Asia', type: 'MOA',
      nature: 'Research', cat: 'Local', unit: 'CETE',
      start: 'Jun 1, 2026', end: 'Jun 1, 2028', status: 'Active', remarks: 'jesttest'
    });
    ceteOnlyId = ceteRes.body.partnership.id;

    // A legacy-shape document inserted directly (bypassing sanitization,
    // which now always normalizes `unit` to an array) to prove the College/
    // Unit filter still matches a real pre-migration record whose `unit`
    // field is a bare string, not an array.
    const db = await connectDB();
    const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    legacyStringUnitId = (last.length ? last[0].id : 0) + 1;
    await db.collection('partnerships').insertOne({
      id: legacyStringUnitId, inst: 'Jest Legacy String-Unit University', country: 'UnitTestland',
      region: 'Asia', type: 'MOA', nature: 'Research', cat: 'Local', unit: 'CILS',
      start: 'Jun 1, 2026', end: 'Jun 1, 2028', status: 'Active', remarks: 'jesttest'
    });
  });

  afterAll(async () => {
    const db = await connectDB();
    await db.collection('partnerships').deleteMany({ id: { $in: [multiUnitId, ceteOnlyId, legacyStringUnitId] } });
  });

  test.each(['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'])(
    'unit=%s only ever returns records genuinely responsible to that unit',
    async (unitValue) => {
      const res = await agent.get(`/api/reports/custom/preview?unit=${unitValue}&country=UnitTestland`);
      expect(res.status).toBe(200);
      expect(res.body.filters.unit).toBe(unitValue);
      expect(res.body.records.every(p =>
        Array.isArray(p.unit) ? p.unit.includes(unitValue) : p.unit === unitValue
      )).toBe(true);
    }
  );

  test('unit=CCS includes the multi-unit (CCS+CIRL) partnership', async () => {
    const res = await agent.get('/api/reports/custom/preview?unit=CCS&country=UnitTestland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
    expect(res.body.records.some(p => p.id === ceteOnlyId)).toBe(false);
  });

  test('unit=CIRL ALSO includes the same multi-unit (CCS+CIRL) partnership', async () => {
    const res = await agent.get('/api/reports/custom/preview?unit=CIRL&country=UnitTestland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
    expect(res.body.records.some(p => p.id === ceteOnlyId)).toBe(false);
  });

  test('unit=CETE excludes the multi-unit (CCS+CIRL) partnership but includes the CETE-only one', async () => {
    const res = await agent.get('/api/reports/custom/preview?unit=CETE&country=UnitTestland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === ceteOnlyId)).toBe(true);
    expect(res.body.records.some(p => p.id === multiUnitId)).toBe(false);
  });

  test('unit=CILS matches a legacy record whose `unit` is still a bare string, not an array', async () => {
    const res = await agent.get('/api/reports/custom/preview?unit=CILS&country=UnitTestland');
    expect(res.status).toBe(200);
    expect(res.body.records.some(p => p.id === legacyStringUnitId)).toBe(true);
  });

  test('"All Units" (no unit param) returns every unit-tagged record together', async () => {
    const res = await agent.get('/api/reports/custom/preview?country=UnitTestland');
    expect(res.status).toBe(200);
    expect(res.body.filters.unit).toBe('All');
    const ids = res.body.records.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining([multiUnitId, ceteOnlyId, legacyStringUnitId]));
  });

  describe('College/Unit combined with other filters (AND, not OR)', () => {
    test('unit + Category (cat)', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&cat=Local&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongCat = await agent.get('/api/reports/custom/preview?unit=CCS&cat=International&country=UnitTestland');
      expect(wrongCat.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Status', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&status=Active&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongStatus = await agent.get('/api/reports/custom/preview?unit=CCS&status=Expired&country=UnitTestland');
      expect(wrongStatus.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Agreement Type', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&agtype=MOA&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongType = await agent.get('/api/reports/custom/preview?unit=CCS&agtype=MOU&country=UnitTestland');
      expect(wrongType.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Region', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&region=Asia&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongRegion = await agent.get('/api/reports/custom/preview?unit=CCS&region=Europe&country=UnitTestland');
      expect(wrongRegion.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Country', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongCountry = await agent.get('/api/reports/custom/preview?unit=CCS&country=NoSuchCountry');
      expect(wrongCountry.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Nature of Partnership (still a real filter capability, just not a Builder UI field)', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&nature=Research&country=UnitTestland');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongNature = await agent.get('/api/reports/custom/preview?unit=CCS&nature=Training&country=UnitTestland');
      expect(wrongNature.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Institution (still a real filter capability, just not a Builder UI field)', async () => {
      const res = await agent.get('/api/reports/custom/preview?unit=CCS&inst=Jest%20Multi-Unit');
      expect(res.status).toBe(200);
      expect(res.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const wrongInst = await agent.get('/api/reports/custom/preview?unit=CCS&inst=NoSuchInstitutionAtAll');
      expect(wrongInst.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });

    test('unit + Date From/Date To', async () => {
      const withinWindow = await agent.get('/api/reports/custom/preview?unit=CCS&dateFrom=2026-01-01&dateTo=2028-12-31&country=UnitTestland');
      expect(withinWindow.status).toBe(200);
      expect(withinWindow.body.records.some(p => p.id === multiUnitId)).toBe(true);
      const outsideWindow = await agent.get('/api/reports/custom/preview?unit=CCS&dateFrom=2000-01-01&dateTo=2001-01-01&country=UnitTestland');
      expect(outsideWindow.body.records.some(p => p.id === multiUnitId)).toBe(false);
    });
  });

  test('Preview, PDF, and Excel agree on the exact same record count for an identical College/Unit filter', async () => {
    const qs = 'unit=CCS&country=UnitTestland';
    const previewRes = await agent.get(`/api/reports/custom/preview?${qs}`);
    expect(previewRes.body.records.some(p => p.id === multiUnitId)).toBe(true);
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
      if (name === 'Jest Multi-Unit University') foundOurRecord = true;
    });
    expect(excelCount).toBe(previewCount);
    expect(foundOurRecord).toBe(true);

    const pdfRes = await agent.get(`/api/reports/partnerships/pdf?${qs}`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('Opening Compare from Preview preserves the College/Unit filter in Group A (the original report)', async () => {
    const res = await agent.get(
      '/api/reports/comparison/preview?compType=Compare%20Against&unit=CCS&country=UnitTestland&compareField=status&compareValue=Active'
    );
    expect(res.status).toBe(200);
    expect(res.body.filters['College / Unit']).toBe('CCS');
    expect(res.body.groupARecords.every(p =>
      Array.isArray(p.unit) ? p.unit.includes('CCS') : p.unit === 'CCS'
    )).toBe(true);
    expect(res.body.groupARecords.some(p => p.id === multiUnitId)).toBe(true);
  });
});

// Mid-Year and Yearly Output Report fixed tile cards must always cover the
// CURRENT calendar year (Jan 1 – Jun 30 / Jan 1 – Dec 31), computed
// dynamically, never a hardcoded year — this is exactly what
// exportMidYearReport()/exportYearlyReport() in reports.ejs send as
// dateFrom/dateTo, and the shared filterByDateRange()/computeCustomReportData
// engine is what actually enforces it, so testing the underlying query params
// proves the fixed tile cards' real behavior end-to-end.
// Regression for the historical-year-leakage bug (2026-09-14 health-check
// follow-up): Mid-Year/Yearly Output Report used to send a client-computed
// dateFrom/dateTo straight into the generic filterByDateRange() — an OVERLAP
// filter (`end >= from && start <= to`). Any still-active multi-year
// partnership signed long before the report's window (e.g. signed 2020,
// running through 2030) "overlaps" every year in between and leaked into
// every Mid-Year/Yearly report regardless of when it was actually
// established. Fixed by having these two report types filter on the
// partnership's own signing date (`start` — the same authoritative field
// Target Tracker's computeTargetAccomplishment() already uses for identical
// "established in period Y" semantics) against a window computed
// server-side from the CURRENT calendar year, and by having reports.ejs send
// `reportType` alone (no dateFrom/dateTo at all) so a client can no longer
// influence the window.
describe('Mid-Year and Yearly Output Report — current-calendar-year-only (no historical leakage)', () => {
  const year = new Date().getFullYear();
  const ids = {};

  beforeAll(async () => {
    // The exact bug scenario: signed well before this year, still active
    // (end date years in the future) — an overlap filter would wrongly
    // include this; a start-date filter correctly excludes it.
    const priorYearActive = await agent.post('/api/partnerships').send({
      inst: 'Jest Leak Prior-Year-Signed Still-Active University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Dec 31, ${year - 1}`, end: `Dec 31, ${year + 5}`, status: 'Active', remarks: 'jesttest'
    });
    ids.priorYearActive = priorYearActive.body.partnership.id;

    // Exact boundary: Jan 1 of the current year — must be included in both.
    const janFirst = await agent.post('/api/partnerships').send({
      inst: 'Jest Jan1 Boundary University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Jan 1, ${year}`, end: `Dec 31, ${year + 3}`, status: 'Active', remarks: 'jesttest'
    });
    ids.janFirst = janFirst.body.partnership.id;

    // Exact boundary: Jun 30 of the current year — last valid Mid-Year day.
    const juneThirty = await agent.post('/api/partnerships').send({
      inst: 'Jest Jun30 Boundary University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Jun 30, ${year}`, end: `Dec 31, ${year + 3}`, status: 'Active', remarks: 'jesttest'
    });
    ids.juneThirty = juneThirty.body.partnership.id;

    // Exact boundary: Jul 1 of the current year — first day EXCLUDED from Mid-Year.
    const julyFirst = await agent.post('/api/partnerships').send({
      inst: 'Jest Jul1 Boundary University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Jul 1, ${year}`, end: `Dec 31, ${year + 3}`, status: 'Active', remarks: 'jesttest'
    });
    ids.julyFirst = julyFirst.body.partnership.id;

    // Exact boundary: Dec 31 of the current year — last valid Yearly day.
    const decThirtyOne = await agent.post('/api/partnerships').send({
      inst: 'Jest Dec31 Boundary University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Dec 31, ${year}`, end: `Dec 31, ${year + 3}`, status: 'Active', remarks: 'jesttest'
    });
    ids.decThirtyOne = decThirtyOne.body.partnership.id;

    // Exact boundary: Jan 1 of NEXT year — first day EXCLUDED from Yearly.
    const nextYearJanFirst = await agent.post('/api/partnerships').send({
      inst: 'Jest NextYear Jan1 University', country: 'DateTestland', region: 'Asia', type: 'MOU',
      nature: 'Research', cat: 'Local', unit: 'CIRL',
      start: `Jan 1, ${year + 1}`, end: `Dec 31, ${year + 5}`, status: 'Active', remarks: 'jesttest'
    });
    ids.nextYearJanFirst = nextYearJanFirst.body.partnership.id;
  });

  afterAll(async () => {
    const db = await connectDB();
    await db.collection('partnerships').deleteMany({ id: { $in: Object.values(ids) } });
  });

  test('Mid-Year (reportType=Mid-Year) excludes the prior-year-signed still-active record and every boundary outside Jan1-Jun30', async () => {
    const res = await agent.get(`/api/reports/custom/preview?reportType=Mid-Year&country=DateTestland`);
    expect(res.status).toBe(200);
    const returned = res.body.records.map(p => p.id);
    expect(returned).toContain(ids.janFirst);
    expect(returned).toContain(ids.juneThirty);
    expect(returned).not.toContain(ids.priorYearActive); // the actual leakage bug
    expect(returned).not.toContain(ids.julyFirst);
    expect(returned).not.toContain(ids.decThirtyOne);
    expect(returned).not.toContain(ids.nextYearJanFirst);
  });

  test('Yearly (reportType=Yearly) excludes the prior-year-signed still-active record and next-year records, includes the full current-year span', async () => {
    const res = await agent.get(`/api/reports/custom/preview?reportType=Yearly&country=DateTestland`);
    expect(res.status).toBe(200);
    const returned = res.body.records.map(p => p.id);
    expect(returned).toContain(ids.janFirst);
    expect(returned).toContain(ids.juneThirty);
    expect(returned).toContain(ids.julyFirst);
    expect(returned).toContain(ids.decThirtyOne);
    expect(returned).not.toContain(ids.priorYearActive); // the actual leakage bug
    expect(returned).not.toContain(ids.nextYearJanFirst);
  });

  test('Mid-Year/Yearly report periods are labeled with the current year and always sum Jan1-Jun30 / Jan1-Dec31', async () => {
    const midYear = await agent.get(`/api/reports/custom/preview?reportType=Mid-Year&country=DateTestland`);
    expect(midYear.body.filters.dateFrom).toBe(`Jan 1, ${year}`);
    expect(midYear.body.filters.dateTo).toBe(`Jun 30, ${year}`);
    expect(midYear.body.periodLabel).toBe(`Report Period: Jan 1, ${year} to Jun 30, ${year}`);

    const yearly = await agent.get(`/api/reports/custom/preview?reportType=Yearly&country=DateTestland`);
    expect(yearly.body.filters.dateFrom).toBe(`Jan 1, ${year}`);
    expect(yearly.body.filters.dateTo).toBe(`Dec 31, ${year}`);
    expect(yearly.body.periodLabel).toBe(`Report Period: Jan 1, ${year} to Dec 31, ${year}`);
  });

  // Section 10 requirement: a client-supplied dateFrom/dateTo must never be
  // able to smuggle in a different year for these two report types — the
  // server derives the window from its own clock regardless of what the
  // query string asks for.
  test('a client-supplied dateFrom/dateTo cannot override the current-year window for Mid-Year/Yearly', async () => {
    const res = await agent.get(
      `/api/reports/custom/preview?reportType=Mid-Year&country=DateTestland&dateFrom=2000-01-01&dateTo=2000-12-31`
    );
    expect(res.status).toBe(200);
    expect(res.body.filters.dateFrom).toBe(`Jan 1, ${year}`);
    expect(res.body.filters.dateTo).toBe(`Jun 30, ${year}`);
    const returned = res.body.records.map(p => p.id);
    expect(returned).toContain(ids.janFirst);
    expect(returned).not.toContain(ids.priorYearActive);
  });

  // Section 8 requirement: the generic Custom Report Builder's Date From/To
  // filter (overlap semantics — correct for "what was active during X") must
  // remain completely unchanged for every OTHER report type. This is the
  // exact record that must NOT appear in Mid-Year/Yearly (its start date is
  // in a prior year) yet SHOULD still appear here, proving the two filters
  // are genuinely independent and neither regressed the other.
  test('generic Date From/To (reportType=Summary) still uses overlap semantics — unaffected by the Mid-Year/Yearly fix', async () => {
    const res = await agent.get(
      `/api/reports/custom/preview?reportType=Summary&country=DateTestland&dateFrom=${year}-01-01&dateTo=${year}-06-30`
    );
    expect(res.status).toBe(200);
    const returned = res.body.records.map(p => p.id);
    expect(returned).toContain(ids.priorYearActive);
  });

  test('PDF and Excel exports for Mid-Year produce the same record set as Preview, and reject the client date-range bypass identically', async () => {
    const previewRes = await agent.get(`/api/reports/custom/preview?reportType=Mid-Year&country=DateTestland`);
    const previewCount = previewRes.body.totalRecords;

    const pdfRes = await agent.get(`/api/reports/partnerships/pdf?reportType=Mid-Year&country=DateTestland&dateFrom=2000-01-01&dateTo=2000-12-31`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await agent.get(`/api/reports/partnerships/excel?reportType=Mid-Year&country=DateTestland&dateFrom=2000-01-01&dateTo=2000-12-31`)
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    let excelCount = 0;
    workbook.worksheets[0].eachRow(row => { if (typeof row.getCell(1).value === 'number') excelCount++; });
    expect(excelCount).toBe(previewCount);
  });

  test('reports.ejs sends reportType (not a client-computed date range) for the Mid-Year/Yearly tile cards', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');
    expect(html).toMatch(/onclick="exportMidYearReport\('pdf'\)"/);
    expect(html).toMatch(/onclick="exportMidYearReport\('excel'\)"/);
    expect(html).toMatch(/onclick="exportYearlyReport\('pdf'\)"/);
    expect(html).toMatch(/onclick="exportYearlyReport\('excel'\)"/);
    expect(html).toMatch(/reportType:\s*'Mid-Year'/);
    expect(html).toMatch(/reportType:\s*'Yearly'/);
    // The old client-side date-range computation (the actual source of the
    // leakage bug) must be gone, not merely unused.
    expect(html).not.toMatch(/function currentYearDateRange/);
  });

  test('conceptual dynamic-year check: the server-side window logic derives from new Date().getFullYear(), never a hardcoded year', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'cirl.js'), 'utf8');
    expect(src).toMatch(/reportType === 'Mid-Year' \|\| reportType === 'Yearly'/);
    expect(src).toMatch(/const currentYear = new Date\(\)\.getFullYear\(\);/);
    // Guards against a regression back to a literal year anywhere in the
    // Mid-Year/Yearly branch specifically (a loose full-file scan would
    // false-positive on unrelated comments/tests elsewhere in this file).
    const branchStart = src.indexOf("reportType === 'Mid-Year' || reportType === 'Yearly'");
    const branch = src.slice(branchStart, branchStart + 600);
    expect(branch).not.toMatch(/20\d\d/);
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

// Phase 3 validation (2026-09-06): the PDF path for a zero-match filter was
// already covered (line ~85), but Excel and Comparison had no equivalent
// regression test proving they degrade the same way — a real, valid,
// empty(ish) output rather than a crash or a silent fallback to the
// unfiltered dataset. `country` is used as the zero-match filter here since
// it is a plain equality match with no legacy/array ambiguity to muddy the
// result.
describe('Empty result set — Preview/Excel/Comparison must never crash or silently ignore the filter', () => {
  const NO_SUCH_COUNTRY = 'jesttest-NoSuchCountry-Phase3';

  test('Preview: a filter matching zero records reports totalRecords: 0, not a misleading count', async () => {
    const res = await agent.get(`/api/reports/custom/preview?country=${encodeURIComponent(NO_SUCH_COUNTRY)}`);
    expect(res.status).toBe(200);
    expect(res.body.totalRecords).toBe(0);
    expect(res.body.records).toEqual([]);
    expect(res.body.summary.totalCount).toBe(0);
  });

  test('Excel export: a filter matching zero records still returns a real, valid, empty workbook', async () => {
    const res = await agent.get(`/api/reports/partnerships/excel?country=${encodeURIComponent(NO_SUCH_COUNTRY)}`)
      .buffer(true).parse((res2, cb) => {
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body); // throws if the file is malformed — proves no crash produced a corrupt file
    expect(workbook.worksheets.length).toBeGreaterThan(0);
    let dataRowCount = 0;
    workbook.worksheets[0].eachRow(row => {
      const first = String(row.getCell(1).value || '');
      if (first.includes(NO_SUCH_COUNTRY)) dataRowCount++; // would only appear if a real record leaked in
    });
    expect(dataRowCount).toBe(0);
  });

  test('Comparison preview: a base filter matching zero records yields totalA=0, totalB=0 — never a fallback to the full dataset', async () => {
    const res = await agent.get(`/api/reports/comparison/preview?compType=Active vs Inactive&country=${encodeURIComponent(NO_SUCH_COUNTRY)}`);
    expect(res.status).toBe(200);
    expect(res.body.totalA).toBe(0);
    expect(res.body.totalB).toBe(0);
    expect(res.body.totalBoth).toBe(0);
    expect(res.body.groupARecords).toEqual([]);
    expect(res.body.groupBRecords).toEqual([]);
  });

  test('Comparison PDF/Excel: a zero-match base filter still produces valid, non-crashing files', async () => {
    const pdfRes = await agent.get(`/api/reports/comparison/pdf?compType=Active vs Inactive&country=${encodeURIComponent(NO_SUCH_COUNTRY)}`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await agent.get(`/api/reports/comparison/excel?compType=Active vs Inactive&country=${encodeURIComponent(NO_SUCH_COUNTRY)}`)
      .buffer(true).parse((res2, cb) => {
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    expect(workbook.worksheets.length).toBeGreaterThan(0);
  });

  test('"Compare Against" with a zero-match ORIGINAL filter keeps Group A empty rather than reverting to the unfiltered registry', async () => {
    const res = await agent.get(
      `/api/reports/comparison/preview?compType=Compare Against&country=${encodeURIComponent(NO_SUCH_COUNTRY)}&compareField=status&compareValue=Active`
    );
    expect(res.status).toBe(200);
    expect(res.body.totalA).toBe(0);
    expect(res.body.groupARecords).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// "Partnership by Country" fixed tile + Custom Report Builder Group By
// (replaces the old "Compliance / Audit Report" tile, 2026-09-18) — Country
// percentage distribution, computed by the SAME computeCustomReportData()
// every other Custom Report Builder report already uses (via the new
// `groupBy` param, which maps onto the pre-existing isComparison/compareBy
// grouped-table machinery — see cirl.js).
// ══════════════════════════════════════════════════════════════════════════
describe('Partnership by Country — Group By dimension (Custom Report Builder)', () => {
  let ids = [];
  const TAG = 'JesttestCountryGroup';

  afterEach(async () => {
    if (ids.length) {
      const db = await connectDB();
      await db.collection('partnerships').deleteMany({ id: { $in: ids } });
      ids = [];
    }
  });

  async function makeFixture(overrides) {
    const res = await agent.post('/api/partnerships').send(Object.assign({
      inst: `${TAG} Institution`, region: 'Asia', type: 'MOA', nature: 'Research',
      unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', remarks: 'jesttest'
    }, overrides));
    ids.push(res.body.partnership.id);
    return res.body.partnership;
  }

  test('1. Country grouping returns correct counts per country', async () => {
    await makeFixture({ country: `${TAG} Philippines` });
    await makeFixture({ country: `${TAG} Philippines` });
    await makeFixture({ country: `${TAG} Japan` });

    const res = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    expect(res.status).toBe(200);
    expect(res.body.isComparison).toBe(true);
    expect(res.body.compareBy).toBe('Country');
    const ph = res.body.comparisonData.find(r => r.group === `${TAG} Philippines`);
    const jp = res.body.comparisonData.find(r => r.group === `${TAG} Japan`);
    expect(ph.Total).toBe(2);
    expect(jp.Total).toBe(1);
  });

  test('2 & 3. Percentages are calculated correctly, from the FILTERED report population (not the whole DB)', async () => {
    await makeFixture({ country: `${TAG} Percentia A` });
    await makeFixture({ country: `${TAG} Percentia A` });
    await makeFixture({ country: `${TAG} Percentia B` });
    await makeFixture({ country: `${TAG} Percentia B` });
    await makeFixture({ country: `${TAG} Percentia B` });
    await makeFixture({ country: `${TAG} Percentia B` });

    const res = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    expect(res.status).toBe(200);
    expect(res.body.totalRecords).toBe(6);
    const a = res.body.comparisonData.find(r => r.group === `${TAG} Percentia A`);
    const b = res.body.comparisonData.find(r => r.group === `${TAG} Percentia B`);
    expect(a['% of Total']).toBe('33.3%');
    expect(b['% of Total']).toBe('66.7%');

    // Percentages must be relative to the FILTERED dataset, not the whole DB:
    // narrowing to Percentia A alone must make it exactly 100% of that report.
    const narrowed = await agent.get(`/api/reports/custom/preview?groupBy=country&country=${encodeURIComponent(TAG + ' Percentia A')}`);
    expect(narrowed.body.comparisonData).toHaveLength(1);
    expect(narrowed.body.comparisonData[0]['% of Total']).toBe('100.0%');
  });

  test('4. Multiple countries all appear in the breakdown, sorted by count descending', async () => {
    await makeFixture({ country: `${TAG} Multi A` });
    await makeFixture({ country: `${TAG} Multi B` });
    await makeFixture({ country: `${TAG} Multi B` });
    await makeFixture({ country: `${TAG} Multi C` });
    await makeFixture({ country: `${TAG} Multi C` });
    await makeFixture({ country: `${TAG} Multi C` });

    const res = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    const groups = res.body.comparisonData.map(r => r.group);
    expect(groups).toEqual([`${TAG} Multi C`, `${TAG} Multi B`, `${TAG} Multi A`]);
  });

  test('5. Missing/blank country values do not crash the report — folded into "Unspecified", never a crash or a stray blank group', async () => {
    await makeFixture({ country: undefined });
    await makeFixture({ country: '   ' });
    await makeFixture({ country: `${TAG} RealCountry` });

    const res = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    expect(res.status).toBe(200);
    expect(res.body.comparisonData.find(r => r.group === '')).toBeUndefined();
    expect(res.body.comparisonData.find(r => r.group === '   ')).toBeUndefined();
    const unspecified = res.body.comparisonData.find(r => r.group === 'Unspecified');
    expect(unspecified.Total).toBe(2);
    const real = res.body.comparisonData.find(r => r.group === `${TAG} RealCountry`);
    expect(real.Total).toBe(1);
  });

  test('6. Preview response includes Country + Count + Percentage for every row (metrics array + row values)', async () => {
    await makeFixture({ country: `${TAG} PreviewCheck` });
    const res = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    expect(res.body.metrics).toEqual(expect.arrayContaining(['Country', 'Total', '% of Total']));
    const row = res.body.comparisonData.find(r => r.group === `${TAG} PreviewCheck`);
    expect(row.Total).toBe(1);
    expect(row['% of Total']).toBe('100.0%');
  });

  test('7. PDF export succeeds for a Country-grouped report (same computeCustomReportData result as Preview)', async () => {
    await makeFixture({ country: `${TAG} PdfCheck` });
    const res = await agent.get(`/api/reports/partnerships/pdf?groupBy=country&inst=${encodeURIComponent(TAG)}&title=Partnership%20by%20Country`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('8. Excel export renders the EXACT same Country/Total/% of Total values Preview computed (not a second calculation)', async () => {
    await makeFixture({ country: `${TAG} ExcelA` });
    await makeFixture({ country: `${TAG} ExcelA` });
    await makeFixture({ country: `${TAG} ExcelB` });

    const previewRes = await agent.get(`/api/reports/custom/preview?groupBy=country&inst=${encodeURIComponent(TAG)}`);
    const excelRes = await agent.get(`/api/reports/partnerships/excel?groupBy=country&inst=${encodeURIComponent(TAG)}&title=Partnership%20by%20Country`)
      .buffer(true).parse((res2, cb) => {
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    const sheet = workbook.worksheets[0];

    // Locate the metrics header row (its cells are exactly
    // customReportData.metrics, e.g. ['Country','Active',...,'Total','% of
    // Total']) by finding the row whose first cell literally reads
    // "Country", then read data rows using THAT row's own column mapping —
    // never a hardcoded column index, which is fragile against metricGroups
    // changing shape.
    let colIndex = {};
    let dataRows = [];
    sheet.eachRow(row => {
      const firstCell = row.getCell(1).value;
      if (firstCell === 'Country' && !dataRows.length && !Object.keys(colIndex).length) {
        row.eachCell((cell, colNumber) => { colIndex[cell.value] = colNumber; });
      } else if (colIndex.Country && (row.getCell(colIndex.Country).value === `${TAG} ExcelA` || row.getCell(colIndex.Country).value === `${TAG} ExcelB`)) {
        dataRows.push(row);
      }
    });
    expect(colIndex.Country).toBeTruthy();
    expect(colIndex.Total).toBeTruthy();
    expect(colIndex['% of Total']).toBeTruthy();

    const foundRows = {};
    dataRows.forEach(row => {
      const country = row.getCell(colIndex.Country).value;
      foundRows[country] = { total: row.getCell(colIndex.Total).value, pct: row.getCell(colIndex['% of Total']).value };
    });
    const previewA = previewRes.body.comparisonData.find(r => r.group === `${TAG} ExcelA`);
    const previewB = previewRes.body.comparisonData.find(r => r.group === `${TAG} ExcelB`);
    expect(foundRows[`${TAG} ExcelA`].total).toBe(previewA.Total);
    expect(foundRows[`${TAG} ExcelA`].pct).toBe(previewA['% of Total']);
    expect(foundRows[`${TAG} ExcelB`].total).toBe(previewB.Total);
    expect(foundRows[`${TAG} ExcelB`].pct).toBe(previewB['% of Total']);
  });

  test('RBAC: Auth. Personnel and potential_partner cannot reach Group By reports; Administrator and Staff can', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const personnelAgent = request.agent(app);
    await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel' }));
    const partnerAgent = request.agent(app);
    await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));

    expect((await agent.get('/api/reports/custom/preview?groupBy=country')).status).toBe(200);
    expect((await staffAgent.get('/api/reports/custom/preview?groupBy=country')).status).toBe(200);
    expect((await personnelAgent.get('/api/reports/custom/preview?groupBy=country')).status).toBe(302);
    expect((await partnerAgent.get('/api/reports/custom/preview?groupBy=country')).status).toBe(302);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Multi-Configuration Comparison (2026-09-18) — /api/reports/comparison/multi/*
// The pre-existing two-group /api/reports/comparison/* engine (tested at
// length above) is completely untouched; these are NEW, additive routes.
// ══════════════════════════════════════════════════════════════════════════
describe('Multi-Configuration Comparison (/api/reports/comparison/multi/*)', () => {
  let ids = [];
  const TAG = 'JesttestMultiCmp';

  afterEach(async () => {
    if (ids.length) {
      const db = await connectDB();
      await db.collection('partnerships').deleteMany({ id: { $in: ids } });
      ids = [];
    }
  });

  async function makeFixture(overrides) {
    const res = await agent.post('/api/partnerships').send(Object.assign({
      inst: `${TAG} Institution`, region: 'Asia', type: 'MOA', nature: 'Research',
      unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active', remarks: 'jesttest'
    }, overrides));
    ids.push(res.body.partnership.id);
    return res.body.partnership;
  }

  test('9. Two configurations (the original workflow\'s shape) still work through the new endpoint', async () => {
    await makeFixture({ country: `${TAG} A` });
    await makeFixture({ country: `${TAG} B` });
    const configs = [
      { label: 'Config A', country: `${TAG} A` },
      { label: 'Config B', country: `${TAG} B` }
    ];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].count).toBe(1);
    expect(res.body.results[1].count).toBe(1);
    expect(res.body.results[0].percentage).toBe(50);
    expect(res.body.results[1].percentage).toBe(50);
  });

  test('10. Three configurations work, each with correct independent counts and percentages', async () => {
    await makeFixture({ country: `${TAG} C1` });
    await makeFixture({ country: `${TAG} C2` });
    await makeFixture({ country: `${TAG} C2` });
    await makeFixture({ country: `${TAG} C3` });
    const configs = [
      { label: 'C1', country: `${TAG} C1` },
      { label: 'C2', country: `${TAG} C2` },
      { label: 'C3', country: `${TAG} C3` }
    ];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.map(r => r.count)).toEqual([1, 2, 1]);
    expect(res.body.results.map(r => r.percentage)).toEqual([25, 50, 25]);
  });

  test('11. Five configurations (the supported maximum) work; a sixth is rejected', async () => {
    const configs5 = [1, 2, 3, 4, 5].map(n => ({ label: 'Cfg ' + n, country: `${TAG} Five${n}` }));
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs5)));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(5);

    const configs6 = configs5.concat([{ label: 'Cfg 6', country: `${TAG} Six` }]);
    const overRes = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs6)));
    expect(overRes.status).toBe(400);
    expect(overRes.body.error).toMatch(/maximum of 5/i);
  });

  test('12 & 13. Add/Remove Comparison at the API level: the configs array length directly controls how many results come back', async () => {
    const two = [{ label: 'X' }, { label: 'Y' }];
    const twoRes = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(two)));
    expect(twoRes.body.results).toHaveLength(2);

    const three = two.concat([{ label: 'Z' }]); // simulates "Add Comparison"
    const threeRes = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(three)));
    expect(threeRes.body.results).toHaveLength(3);

    const backToTwo = three.slice(0, 2); // simulates "Remove Comparison"
    const removedRes = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(backToTwo)));
    expect(removedRes.body.results).toHaveLength(2);
  });

  test('14. Each comparison configuration keeps fully independent filters — never merged across configs', async () => {
    await makeFixture({ country: `${TAG} Philippines`, start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active' });
    await makeFixture({ country: `${TAG} Japan`, start: 'Jan 1, 2020', end: 'Jan 1, 2022', status: 'Expired' });
    await makeFixture({ country: `${TAG} Thailand`, start: 'Jan 1, 2026', end: 'Jan 1, 2030', status: 'Active' });

    const configs = [
      { label: 'Comparison 1', country: `${TAG} Philippines`, status: 'Active' },
      { label: 'Comparison 2', country: `${TAG} Japan`, status: 'Expired' },
      { label: 'Comparison 3', country: `${TAG} Thailand`, status: 'Active' }
    ];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.status).toBe(200);
    const [c1, c2, c3] = res.body.results;
    // Each config's own record set must ONLY reflect its OWN filters — a
    // Japan/Expired config must never pick up the Philippines/Active record
    // or vice versa (which merged/shared filter state would cause).
    expect(c1.count).toBe(1);
    expect(c1.records.every(p => p.country === `${TAG} Philippines` && p.status === 'Active')).toBe(true);
    expect(c2.count).toBe(1);
    expect(c2.records.every(p => p.country === `${TAG} Japan` && p.status === 'Expired')).toBe(true);
    expect(c3.count).toBe(1);
    expect(c3.records.every(p => p.country === `${TAG} Thailand` && p.status === 'Active')).toBe(true);
  });

  test('15. Comparison result clearly identifies which result belongs to which configuration (labels + stable ids, in submitted order)', async () => {
    await makeFixture({ country: `${TAG} Alpha` });
    await makeFixture({ country: `${TAG} Beta` });
    const configs = [
      { label: 'Current Year', country: `${TAG} Alpha` },
      { label: 'Previous Year', country: `${TAG} Beta` }
    ];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.body.results[0].label).toBe('Current Year');
    expect(res.body.results[0].id).toBe(0);
    expect(res.body.results[1].label).toBe('Previous Year');
    expect(res.body.results[1].id).toBe(1);
  });

  test('16. "Total Compared" never appears anywhere in the multi-comparison preview JSON, PDF, or Excel', async () => {
    await makeFixture({ country: `${TAG} NoTotalCompared` });
    const configs = [{ label: 'A', country: `${TAG} NoTotalCompared` }, { label: 'B' }];
    const qs = 'configs=' + encodeURIComponent(JSON.stringify(configs));

    const previewRes = await agent.get('/api/reports/comparison/multi/preview?' + qs);
    expect(JSON.stringify(previewRes.body)).not.toMatch(/Total Compared/i);

    const pdfRes = await agent.get('/api/reports/comparison/multi/pdf?' + qs);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.text || pdfRes.body.toString('latin1')).not.toMatch(/Total Compared/i);

    const excelRes = await agent.get('/api/reports/comparison/multi/excel?' + qs)
      .buffer(true).parse((res2, cb) => {
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    let foundTotalCompared = false;
    workbook.worksheets.forEach(sheet => {
      sheet.eachRow(row => {
        row.eachCell(cell => {
          if (typeof cell.value === 'string' && /Total Compared/i.test(cell.value)) foundTotalCompared = true;
        });
      });
    });
    expect(foundTotalCompared).toBe(false);
  });

  test('17. Legitimate per-configuration totals/counts remain fully intact (not removed alongside "Total Compared")', async () => {
    await makeFixture({ country: `${TAG} LegitTotal` });
    const configs = [{ label: 'Legit', country: `${TAG} LegitTotal` }, { label: 'Empty', country: 'NoSuchCountryZZZ' }];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.body.results[0].count).toBe(1);
    expect(res.body.results[0].percentage).toBe(100);
    expect(res.body.results[1].count).toBe(0);
    expect(res.body.results[1].percentage).toBe(0);
  });

  test('18. Empty comparison results are handled correctly: a config matching zero records never crashes, and an empty configs array is rejected with a clear error', async () => {
    const configs = [{ label: 'Zero', country: 'NoSuchCountryZZZ' }, { label: 'AlsoZero', country: 'AnotherFakeCountryZZZ' }];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.status).toBe(200);
    expect(res.body.results[0].count).toBe(0);
    expect(res.body.results[0].percentage).toBe(0);
    expect(res.body.results[1].count).toBe(0);

    const emptyRes = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify([])));
    expect(emptyRes.status).toBe(400);
    expect(emptyRes.body.error).toMatch(/at least one/i);
  });

  test('19. The pre-existing two-way /api/reports/comparison/* engine is completely unaffected by the new multi routes', async () => {
    const res = await agent.get('/api/reports/comparison/preview?compType=Active%20vs%20Inactive');
    expect(res.status).toBe(200);
    expect(res.body.groupA).toBe('Active');
    expect(res.body.groupB).toBe('Inactive');
    expect(typeof res.body.totalBoth).toBe('number');
  });

  test('PDF/Excel export succeed for a 4-configuration comparison', async () => {
    await makeFixture({ country: `${TAG} Pdf1` });
    await makeFixture({ country: `${TAG} Pdf2` });
    const configs = [
      { label: 'One', country: `${TAG} Pdf1` }, { label: 'Two', country: `${TAG} Pdf2` },
      { label: 'Three' }, { label: 'Four' }
    ];
    const qs = 'configs=' + encodeURIComponent(JSON.stringify(configs));

    const pdfRes = await agent.get('/api/reports/comparison/multi/pdf?' + qs);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');

    const excelRes = await agent.get('/api/reports/comparison/multi/excel?' + qs)
      .buffer(true).parse((res2, cb) => {
        const chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(excelRes.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelRes.body);
    // 1 summary sheet + 1 records sheet per configuration (4) = 5 sheets.
    expect(workbook.worksheets.length).toBe(5);
    expect(workbook.worksheets[0].name).toBe('Comparison Summary');
  });

  test('20 & 21. RBAC — Administrator and Staff can both reach every multi-comparison route', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const configs = [{ label: 'A' }, { label: 'B' }];
    const qs = 'configs=' + encodeURIComponent(JSON.stringify(configs));

    const adminPreview = await agent.get('/api/reports/comparison/multi/preview?' + qs);
    expect(adminPreview.status).toBe(200);
    const staffPreview = await staffAgent.get('/api/reports/comparison/multi/preview?' + qs);
    expect(staffPreview.status).toBe(200);

    const staffPdf = await staffAgent.get('/api/reports/comparison/multi/pdf?' + qs);
    expect(staffPdf.status).toBe(200);
    const staffExcel = await staffAgent.get('/api/reports/comparison/multi/excel?' + qs);
    expect(staffExcel.status).toBe(200);
  });

  test('22. Existing restricted roles (Auth. Personnel, potential_partner) remain forbidden from every multi-comparison route', async () => {
    const personnelAgent = request.agent(app);
    await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel' }));
    const partnerAgent = request.agent(app);
    await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
    const configs = [{ label: 'A' }, { label: 'B' }];
    const qs = 'configs=' + encodeURIComponent(JSON.stringify(configs));

    expect((await personnelAgent.get('/api/reports/comparison/multi/preview?' + qs)).status).toBe(302);
    expect((await partnerAgent.get('/api/reports/comparison/multi/preview?' + qs)).status).toBe(302);
    expect((await personnelAgent.get('/api/reports/comparison/multi/pdf?' + qs)).status).toBe(302);
    expect((await partnerAgent.get('/api/reports/comparison/multi/excel?' + qs)).status).toBe(302);

    const unauthRes = await request(app).get('/api/reports/comparison/multi/preview?' + qs);
    expect(unauthRes.status).toBe(302);
  });

  test('Malformed configs payload (invalid JSON / non-array) is rejected with a clear 400, never a crash', async () => {
    const badJson = await agent.get('/api/reports/comparison/multi/preview?configs=not-json');
    expect(badJson.status).toBe(400);

    const notArray = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify({ foo: 'bar' })));
    expect(notArray.status).toBe(400);

    const missing = await agent.get('/api/reports/comparison/multi/preview');
    expect(missing.status).toBe(400);
  });

  test('A non-object entry in the configs array is normalized away rather than reaching the query engine unsafely', async () => {
    const configs = ['not-an-object', { label: 'RealConfig' }, 42, null];
    const res = await agent.get('/api/reports/comparison/multi/preview?configs=' + encodeURIComponent(JSON.stringify(configs)));
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(4);
    expect(res.body.results[1].label).toBe('RealConfig');
  });
});
