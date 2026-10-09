const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001's readings by timestamp (UTC):
//   …001 2026-10-05T18:15Z (23:45 Sri Lanka, 5 Oct)   …002 2026-10-06T00:30Z   …003 04:30Z
//   …004 06:30Z   …005 12:30Z
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const R = (n) => n.toString(16).padStart(24, '0');
const PATH = '/installations/INS-0001/readings';
const ids = (res) => res.body.results.map((r) => r.reading_id);
const get = (query) => request(app).get(`${PATH}?${query}`);

describe('filtering by time window [from, to)', () => {
  test('from only: readings at or after it (inclusive)', async () => {
    const res = await get('from=2026-10-06T04:30:00Z');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([R(5), R(4), R(3)]);
    expect(res.body.count).toBe(3);
  });

  test('to only: readings before it (exclusive)', async () => {
    expect(ids(await get('to=2026-10-06T04:30:00Z'))).toEqual([R(2), R(1)]);
  });

  test('both: from inclusive, to exclusive', async () => {
    expect(ids(await get('from=2026-10-06T00:30:00Z&to=2026-10-06T06:30:00Z'))).toEqual([R(3), R(2)]);
  });

  test('adjacent windows never count a reading twice', async () => {
    const a = ids(await get('from=2026-10-06T00:30:00Z&to=2026-10-06T06:30:00Z'));
    const b = ids(await get('from=2026-10-06T06:30:00Z&to=2026-10-06T13:00:00Z'));
    expect([...a, ...b].sort()).toEqual([R(2), R(3), R(4), R(5)]);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  test('the time zone is respected: a Sri Lanka day is not the UTC day', async () => {
    // The Sri Lanka day of 6 Oct runs from 2026-10-05T18:30Z to 2026-10-06T18:30Z, so the 23:45 SL reading (…001, 5 Oct) is outside.
    const slDay = await get('from=2026-10-06T00:00:00%2B05:30&to=2026-10-07T00:00:00%2B05:30');
    expect(ids(slDay)).toEqual([R(5), R(4), R(3), R(2)]);
    // 23:00 on 5 Oct in Sri Lanka (17:30Z) includes …001; 23:00 UTC does not.
    expect(ids(await get('from=2026-10-05T23:00:00%2B05:30&to=2026-10-06T00:00:00Z'))).toEqual([R(1)]);
    expect(ids(await get('from=2026-10-05T23:00:00Z&to=2026-10-06T00:00:00Z'))).toEqual([]);
  });

  test('an unencoded "+" in the offset (sent as a space) is understood as +', async () => {
    const encoded = await get('from=2026-10-06T00:00:00%2B05:30');
    const unencoded = await get('from=2026-10-06T00:00:00+05:30');
    expect(unencoded.status).toBe(200);
    expect(ids(unencoded)).toEqual(ids(encoded));
  });

  test('a window with no readings (e.g. in the future) → 200 with count 0', async () => {
    expect((await get('from=2030-01-01T00:00:00Z')).body).toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  test('filters on measurement time (timestamp), not received_at', async () => {
    // received_at is 5 s after timestamp; a window ending 2 s after …005's timestamp still includes it.
    expect(ids(await get('from=2026-10-06T12:30:00Z&to=2026-10-06T12:30:02Z'))).toEqual([R(5)]);
  });
});

describe('the window works with pagination', () => {
  test('count reflects the window, and next/previous keep it (as canonical UTC)', async () => {
    const first = await get('from=2026-10-06T00:00:00%2B05:30&to=2026-10-07T00:00:00%2B05:30&page-size=2');
    expect(first.body.count).toBe(4);
    const next = new URLSearchParams(first.body.next.split('?')[1]);
    expect([...next.keys()]).toEqual(['page', 'page-size', 'from', 'to', 'sort']);
    expect(next.get('from')).toBe('2026-10-05T18:30:00.000Z');
    expect(next.get('to')).toBe('2026-10-06T18:30:00.000Z');
  });

  test('following the links stays inside the window', async () => {
    const seen = [];
    let url = `${PATH}?from=2026-10-06T00:00:00%2B05:30&to=2026-10-07T00:00:00%2B05:30&page-size=1`;
    while (url) {
      const res = await request(app).get(url);
      seen.push(...ids(res));
      url = res.body.next;
    }
    expect(seen).toEqual([R(5), R(4), R(3), R(2)]);
  });
});

describe('invalid values → 400', () => {
  test.each([
    ['not a date', 'from=yesterday', 'from'],
    ['a date only', 'from=2026-10-05', 'from'],
    ['no time zone', 'to=2026-10-05T00:00:00', 'to'],
    ['a number', 'from=1791290700000', 'from'],
    ['empty', 'to=', 'to'],
    ['given twice', 'from=2026-10-05T00:00:00Z&from=2026-10-06T00:00:00Z', 'from'],
    ['an impossible date', 'from=2026-02-30T00:00:00Z', 'from'],
  ])('%s → INVALID_QUERY_PARAMETER naming %s', async (label, query, field) => {
    const res = await get(query);
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details).toEqual([{ field, location: 'query', issue: expect.stringContaining('time zone'), reference: null }]);
  });

  test('from after to → INVALID_TIME_WINDOW naming both', async () => {
    const res = await get('from=2026-10-06T12:00:00Z&to=2026-10-06T06:00:00Z');
    expectErrorBody(res, 400, 'INVALID_TIME_WINDOW');
    expect(res.body.details.map((d) => d.field)).toEqual(['from', 'to']);
  });

  test('from equal to to (an empty window) → INVALID_TIME_WINDOW', async () => {
    expectErrorBody(await get('from=2026-10-06T06:00:00Z&to=2026-10-06T06:00:00Z'), 400, 'INVALID_TIME_WINDOW');
  });

  test('the same instant written two ways is still equal → INVALID_TIME_WINDOW', async () => {
    expectErrorBody(await get('from=2026-10-06T11:30:00%2B05:30&to=2026-10-06T06:00:00Z'), 400, 'INVALID_TIME_WINDOW');
  });

  test('every malformed value is reported in one 400 (page, page-size, from and to together)', async () => {
    const res = await get('page=0&page-size=500&from=bad&to=2026-10-05');
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details.map((d) => d.field)).toEqual(['page', 'page-size', 'from', 'to']);
  });

  test('a missing installation is 404 before the window is checked', async () => {
    expectErrorBody(await request(app).get('/installations/INS-9999/readings?from=bad'), 404, 'INSTALLATION_NOT_FOUND');
  });
});
