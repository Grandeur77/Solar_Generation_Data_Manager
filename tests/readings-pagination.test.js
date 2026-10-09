const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { MAX_PAGE_SIZE } = require('../src/utils/pagination');
const { setUpTestDatabase, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0002 gets 22 extra readings here, 25 in all; INS-0005 stays empty.
const TOTAL = 25;
const PATH = '/installations/INS-0002/readings';

beforeAll(async () => {
  await setUpTestDatabase();
  const extra = Array.from({ length: TOTAL - 3 }, (_, i) => ({
    installation_id: 'INS-0002',
    timestamp: new Date(Date.parse('2026-10-06T12:45:00Z') + i * 15 * 60 * 1000),
    power_kw: 0.5,
    energy_kwh: 511 + i,
    voltage: 230,
    received_at: new Date(Date.parse('2026-10-06T12:45:05Z') + i * 15 * 60 * 1000),
    substation_id: 'SS-001',
    district_id: 'DT-01',
    province_id: 'PV-01',
  }));
  await GenerationReading.insertMany(extra);
});
afterAll(tearDownTestDatabase);

const get = (path) => request(app).get(path);
const link = (page, size) => `${PATH}?page=${page}&page-size=${size}&sort=-timestamp`;

describe('page object shape', () => {
  test('exactly count, next, previous and results; no envelope', async () => {
    const res = await get(`${PATH}?page-size=10`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['count', 'next', 'previous', 'results']);
    expect(res.body.count).toBe(TOTAL);
  });

  test('defaults: page 1, page-size 50 (all 25 fit, so no next or previous)', async () => {
    const res = await get(PATH);
    expect(res.body).toMatchObject({ count: TOTAL, next: null, previous: null });
    expect(res.body.results).toHaveLength(TOTAL);
  });
});

describe('the edges with page-size=10 (pages of 10, 10 and 5)', () => {
  test('first page: previous is null, next is page 2', async () => {
    const res = await get(`${PATH}?page=1&page-size=10`);
    expect(res.body.previous).toBeNull();
    expect(res.body.next).toBe(link(2, 10));
    expect(res.body.results).toHaveLength(10);
  });

  test('middle page: both links set', async () => {
    const res = await get(`${PATH}?page=2&page-size=10`);
    expect(res.body.previous).toBe(link(1, 10));
    expect(res.body.next).toBe(link(3, 10));
    expect(res.body.results).toHaveLength(10);
  });

  test('last page: next is null, previous is page 2, and it holds the remaining 5', async () => {
    const res = await get(`${PATH}?page=3&page-size=10`);
    expect(res.body.next).toBeNull();
    expect(res.body.previous).toBe(link(2, 10));
    expect(res.body.results).toHaveLength(5);
  });

  test('a page past the end: 200, empty results, next null, previous leads back to the last real page', async () => {
    const res = await get(`${PATH}?page=9&page-size=10`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: TOTAL, next: null, previous: link(3, 10), results: [] });
  });

  test('count is the total across all pages, the same on every page', async () => {
    for (const page of [1, 2, 3, 9]) expect((await get(`${PATH}?page=${page}&page-size=10`)).body.count).toBe(TOTAL);
  });

  test('exactly a full last page (page-size 5 → 5 pages): page 5 has no next', async () => {
    const res = await get(`${PATH}?page=5&page-size=5`);
    expect(res.body.results).toHaveLength(5);
    expect(res.body.next).toBeNull();
  });

  test('page-size 1: first and last pages', async () => {
    expect((await get(`${PATH}?page=1&page-size=1`)).body.previous).toBeNull();
    const last = await get(`${PATH}?page=${TOTAL}&page-size=1`);
    expect(last.body.next).toBeNull();
    expect(last.body.results).toHaveLength(1);
  });
});

describe('following the links', () => {
  test('walking next from page 1 visits every reading exactly once, newest first', async () => {
    const seen = [];
    let url = `${PATH}?page-size=10`;
    while (url) {
      const res = await get(url);
      expect(res.status).toBe(200);
      seen.push(...res.body.results.map((r) => r.timestamp));
      url = res.body.next;
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect([...seen].sort().reverse()).toEqual(seen);
  });

  test('links are relative, canonical and always carry page-size and sort, even when defaults were used', async () => {
    const res = await get(`${PATH}?page=1&page-size=10`);
    expect(res.body.next.startsWith('/installations/INS-0002/readings?')).toBe(true);
    const params = new URLSearchParams(res.body.next.split('?')[1]);
    expect([...params.keys()]).toEqual(['page', 'page-size', 'sort']);
    expect(params.get('sort')).toBe('-timestamp');
    const viaDefaults = await get(`${PATH}?page=2`); // page-size left to its default
    expect(viaDefaults.body.previous).toBe(link(1, 50));
  });
});

describe('an empty history', () => {
  test('count 0, no links, empty results', async () => {
    expect((await get('/installations/INS-0005/readings')).body).toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  test('page 2 of an empty history: still no previous (there is no page with items)', async () => {
    expect((await get('/installations/INS-0005/readings?page=2')).body).toEqual({ count: 0, next: null, previous: null, results: [] });
  });
});

describe('invalid page values → 400 INVALID_QUERY_PARAMETER', () => {
  test(`page-size ${MAX_PAGE_SIZE} is the cap and is accepted`, async () => {
    expect((await get(`${PATH}?page-size=${MAX_PAGE_SIZE}`)).status).toBe(200);
  });

  test.each([
    ['page-size above the cap', `page-size=${MAX_PAGE_SIZE + 1}`, 'page-size'],
    ['page-size 0', 'page-size=0', 'page-size'],
    ['page 0', 'page=0', 'page'],
    ['negative page', 'page=-1', 'page'],
    ['decimal page', 'page=1.5', 'page'],
    ['text page-size', 'page-size=ten', 'page-size'],
    ['empty page', 'page=', 'page'],
    ['page given twice', 'page=1&page=2', 'page'],
  ])('%s → 400 naming that parameter', async (label, query, field) => {
    const res = await get(`${PATH}?${query}`);
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details).toEqual([{ field, location: 'query', issue: expect.any(String), reference: null }]);
  });

  test('both invalid → both reported at once', async () => {
    const res = await get(`${PATH}?page=0&page-size=500`);
    expect(res.body.details.map((d) => d.field)).toEqual(['page', 'page-size']);
  });

  test('a missing installation is 404 before the page values are checked', async () => {
    expectErrorBody(await get('/installations/INS-9999/readings?page-size=500'), 404, 'INSTALLATION_NOT_FOUND');
  });
});
