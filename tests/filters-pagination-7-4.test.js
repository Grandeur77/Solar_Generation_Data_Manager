const request = require('./helpers/authed-request');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Installations: INS-0001 Kolonnawa 5 kW, INS-0002 Kolonnawa 3 kW, INS-0003 Gampaha 4 kW,
// INS-0004 Kandy 10 kW (inactive), INS-0005 Kolonnawa 2 kW. PV-01 holds all but INS-0004.
// INS-0001 readings (newest first): …005 0.5 kW, …004 4 kW, …003 3 kW, …002 0 kW, …001 0 kW.
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const get = (path) => request(app).get(path);
const ids = (res) => res.body.results.map((i) => i.installation_id);
const last = (res) => res.body.results.map((r) => r.reading_id.slice(-1));
const params = (url) => [...new URLSearchParams(url.split('?')[1]).entries()];

describe('/installations is paginated', () => {
  test('the page object, in installation_id order by default', async () => {
    const res = await get('/installations');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['count', 'next', 'previous', 'results']);
    expect(res.body).toMatchObject({ count: 5, next: null, previous: null });
    expect(ids(res)).toEqual(['INS-0001', 'INS-0002', 'INS-0003', 'INS-0004', 'INS-0005']);
  });

  test('pages of 2: links, nulls at the edges, and the remaining one on the last page', async () => {
    const first = await get('/installations?page-size=2');
    expect(ids(first)).toEqual(['INS-0001', 'INS-0002']);
    expect(first.body.previous).toBeNull();
    expect(params(first.body.next)).toEqual([['page', '2'], ['page-size', '2'], ['sort', 'installation_id']]);

    const lastPage = await get('/installations?page=3&page-size=2');
    expect(ids(lastPage)).toEqual(['INS-0005']);
    expect(lastPage.body.next).toBeNull();
    expect(lastPage.body.count).toBe(5);
  });

  test('links keep every filter, in a fixed order, and following them stays filtered', async () => {
    const res = await get('/installations?status=active&substation-id=SS-001&province-id=PV-01&page-size=1');
    expect(params(res.body.next)).toEqual([
      ['page', '2'],
      ['page-size', '1'],
      ['province-id', 'PV-01'],
      ['substation-id', 'SS-001'],
      ['status', 'active'],
      ['sort', 'installation_id'],
    ]);
    const walked = [];
    let url = res.request.url.replace(/^https?:\/\/[^/]+/, '');
    while (url) {
      const page = await get(url);
      walked.push(...ids(page));
      url = page.body.next;
    }
    expect(walked).toEqual(['INS-0001', 'INS-0002', 'INS-0005']);
  });

  test('page-size above 100 → 400', async () => {
    expectErrorBody(await get('/installations?page-size=101'), 400, 'INVALID_QUERY_PARAMETER');
  });
});

describe('?status= on installations', () => {
  test('inactive → only INS-0004', async () => {
    expect(ids(await get('/installations?status=inactive'))).toEqual(['INS-0004']);
  });

  test('active → the other four', async () => {
    const res = await get('/installations?status=active');
    expect(res.body.count).toBe(4);
    expect(ids(res)).not.toContain('INS-0004');
  });

  test('combines with the jurisdiction filters (AND)', async () => {
    expect((await get('/installations?province-id=PV-01&status=inactive')).body).toMatchObject({ count: 0, results: [] });
    expect(ids(await get('/installations?province-id=PV-02&status=inactive'))).toEqual(['INS-0004']);
  });

  test.each(['status=retired', 'status=Active', 'status=', 'status=active&status=inactive'])('?%s → 400 naming status', async (query) => {
    const res = await get(`/installations?${query}`);
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details).toEqual([{ field: 'status', location: 'query', issue: expect.stringContaining('active, inactive'), reference: null }]);
  });
});

describe('sorting installations (installation_id, name, capacity_kw)', () => {
  test('sort=-capacity_kw → largest first', async () => {
    expect(ids(await get('/installations?sort=-capacity_kw'))).toEqual(['INS-0004', 'INS-0001', 'INS-0003', 'INS-0002', 'INS-0005']);
  });

  test('sort=capacity_kw → smallest first', async () => {
    expect(ids(await get('/installations?sort=capacity_kw'))).toEqual(['INS-0005', 'INS-0002', 'INS-0003', 'INS-0001', 'INS-0004']);
  });

  test('sort=name and sort=-name', async () => {
    expect(ids(await get('/installations?sort=name'))).toEqual(['INS-0003', 'INS-0004', 'INS-0001', 'INS-0002', 'INS-0005']);
    expect(ids(await get('/installations?sort=-name'))).toEqual(['INS-0005', 'INS-0002', 'INS-0001', 'INS-0004', 'INS-0003']);
  });

  test('sort=-installation_id → highest id first', async () => {
    expect(ids(await get('/installations?sort=-installation_id'))[0]).toBe('INS-0005');
  });

  test('an unknown sort field → 400 listing the installation fields', async () => {
    const res = await get('/installations?sort=power_kw');
    expectErrorBody(res, 400, 'INVALID_SORT_FIELD');
    expect(res.body.details[0].reference).toBe('installation_id, name, capacity_kw');
  });

  describe('ties', () => {
    afterAll(loadTestSeed);
    test('equal capacities are ordered by installation_id ascending', async () => {
      await SolarInstallation.updateOne({ _id: 'INS-0002' }, { capacity_kw: 5 }); // now equal to INS-0001
      expect(ids(await get('/installations?sort=-capacity_kw'))).toEqual(['INS-0004', 'INS-0001', 'INS-0002', 'INS-0003', 'INS-0005']);
    });
  });
});

describe('every malformed filter is reported in one 400', () => {
  test('/installations: province-id, district-id, status and page all at once', async () => {
    const res = await get('/installations?province-id=x&district-id=y&status=z&page=0');
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details.map((d) => d.field)).toEqual(['province-id', 'district-id', 'status', 'page']);
  });

  test('/grid-substations: both filters at once (it used to stop at the first)', async () => {
    const res = await get('/grid-substations?province-id=x&district-id=y');
    expect(res.body.details.map((d) => d.field)).toEqual(['province-id', 'district-id']);
  });

  test('malformed filters are reported before the sort', async () => {
    expectErrorBody(await get('/installations?status=z&sort=power_kw'), 400, 'INVALID_QUERY_PARAMETER');
  });
});

describe('?min-power-kw= on readings', () => {
  const PATH = '/installations/INS-0001/readings';

  test('min-power-kw=3 → only readings at or above 3 kW', async () => {
    const res = await get(`${PATH}?min-power-kw=3`);
    expect(last(res)).toEqual(['4', '3']);
    expect(res.body.count).toBe(2);
  });

  test('the bound is inclusive: 0.5 includes the 0.5 kW reading', async () => {
    expect(last(await get(`${PATH}?min-power-kw=0.5`))).toEqual(['5', '4', '3']);
  });

  test('min-power-kw=0 keeps everything', async () => {
    expect((await get(`${PATH}?min-power-kw=0`)).body.count).toBe(5);
  });

  test('works with the window, sort and pagination, and the links keep it', async () => {
    const res = await get(`${PATH}?from=2026-10-06T00:00:00Z&min-power-kw=0.1&sort=power_kw&page-size=1`);
    expect(res.body.count).toBe(3);
    expect(last(res)).toEqual(['5']);
    expect(params(res.body.next)).toEqual([
      ['page', '2'],
      ['page-size', '1'],
      ['from', '2026-10-06T00:00:00.000Z'],
      ['min-power-kw', '0.1'],
      ['sort', 'power_kw'],
    ]);
  });

  test.each(['min-power-kw=-1', 'min-power-kw=abc', 'min-power-kw=1e3', 'min-power-kw=', 'min-power-kw=1&min-power-kw=2'])(
    '?%s → 400 naming min-power-kw',
    async (query) => {
      const res = await get(`${PATH}?${query}`);
      expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
      expect(res.body.details.map((d) => d.field)).toEqual(['min-power-kw']);
    }
  );

  test('reported together with the other bad readings parameters', async () => {
    const res = await get(`${PATH}?page=0&from=bad&min-power-kw=-1`);
    expect(res.body.details.map((d) => d.field)).toEqual(['page', 'from', 'min-power-kw']);
  });
});
