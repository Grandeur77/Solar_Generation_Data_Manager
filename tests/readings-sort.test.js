const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001, oldest to newest:
//   …001 18:15Z (5 Oct) power 0    energy 1000
//   …002 00:30Z         power 0    energy 1000
//   …003 04:30Z         power 3    energy 1006
//   …004 06:30Z         power 4    energy 1013
//   …005 12:30Z         power 0.5  energy 1020
// Equal values are ordered newest first (tie-breaker: timestamp).
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const R = (n) => n.toString(16).padStart(24, '0');
const PATH = '/installations/INS-0001/readings';
const order = async (query) => {
  const res = await request(app).get(`${PATH}?${query}`);
  expect(res.status).toBe(200);
  return res.body.results.map((r) => r.reading_id.slice(-1));
};

describe('timestamp, both directions', () => {
  test('no sort → newest first (the default)', async () => {
    expect(await order('')).toEqual(['5', '4', '3', '2', '1']);
  });

  test('sort=-timestamp → newest first', async () => {
    expect(await order('sort=-timestamp')).toEqual(['5', '4', '3', '2', '1']);
  });

  test('sort=timestamp → oldest first', async () => {
    expect(await order('sort=timestamp')).toEqual(['1', '2', '3', '4', '5']);
  });

  test('the two directions are exact reverses of each other', async () => {
    expect((await order('sort=timestamp')).reverse()).toEqual(await order('sort=-timestamp'));
  });
});

describe('power_kw and energy_kwh, both directions, ties newest first', () => {
  test('sort=-power_kw → highest first; the two zero readings newest first', async () => {
    expect(await order('sort=-power_kw')).toEqual(['4', '3', '5', '2', '1']);
  });

  test('sort=power_kw → lowest first; the two zero readings newest first', async () => {
    expect(await order('sort=power_kw')).toEqual(['2', '1', '5', '3', '4']);
  });

  test('sort=energy_kwh → lowest first; the two 1000 kWh readings newest first', async () => {
    expect(await order('sort=energy_kwh')).toEqual(['2', '1', '3', '4', '5']);
  });

  test('sort=-energy_kwh → highest first', async () => {
    expect(await order('sort=-energy_kwh')).toEqual(['5', '4', '3', '2', '1']);
  });

  test('sort=-power_kw finds the peak reading first', async () => {
    const res = await request(app).get(`${PATH}?sort=-power_kw&page-size=1`);
    expect(res.body.results[0]).toMatchObject({ reading_id: R(4), power_kw: 4 });
  });
});

describe('sort with pagination and the time window', () => {
  test('links keep the chosen sort', async () => {
    const res = await request(app).get(`${PATH}?sort=power_kw&page-size=2`);
    expect(new URLSearchParams(res.body.next.split('?')[1]).get('sort')).toBe('power_kw');
  });

  test('walking the pages of a sort with ties gives every reading once, in the same order as one big page', async () => {
    const onePage = await order('sort=power_kw&page-size=100');
    const walked = [];
    let url = `${PATH}?sort=power_kw&page-size=1`;
    while (url) {
      const res = await request(app).get(url);
      walked.push(...res.body.results.map((r) => r.reading_id.slice(-1)));
      url = res.body.next;
    }
    expect(walked).toEqual(onePage);
  });

  test('sort, window and pagination together', async () => {
    // Sri Lanka day of 6 Oct (…002 to …005), highest power first, two per page.
    const res = await request(app).get(`${PATH}?from=2026-10-06T00:00:00%2B05:30&to=2026-10-07T00:00:00%2B05:30&sort=-power_kw&page-size=2`);
    expect(res.body.count).toBe(4);
    expect(res.body.results.map((r) => r.reading_id.slice(-1))).toEqual(['4', '3']);
    const next = new URLSearchParams(res.body.next.split('?')[1]);
    expect([...next.entries()]).toEqual([
      ['page', '2'],
      ['page-size', '2'],
      ['from', '2026-10-05T18:30:00.000Z'],
      ['to', '2026-10-06T18:30:00.000Z'],
      ['sort', '-power_kw'],
    ]);
    const page2 = await request(app).get(res.body.next);
    expect(page2.body.results.map((r) => r.reading_id.slice(-1))).toEqual(['5', '2']);
  });
});

describe('invalid sort → 400 INVALID_SORT_FIELD listing the allowed fields', () => {
  test.each([
    ['a field that exists but is not sortable', 'sort=voltage'],
    ['an unknown field', 'sort=name'],
    ['two fields', 'sort=timestamp,power_kw'],
    ['an empty value', 'sort='],
    ['only a minus', 'sort=-'],
    ['a double minus', 'sort=--timestamp'],
    ['the wrong case', 'sort=Timestamp'],
    ['camelCase', 'sort=powerKw'],
    ['an unencoded + (arrives as a space)', 'sort=+power_kw'],
    ['given twice', 'sort=timestamp&sort=-timestamp'],
  ])('%s', async (label, query) => {
    const res = await request(app).get(`${PATH}?${query}`);
    expectErrorBody(res, 400, 'INVALID_SORT_FIELD');
    expect(res.body.details).toEqual([
      { field: 'sort', location: 'query', issue: expect.any(String), reference: 'timestamp, power_kw, energy_kwh' },
    ]);
  });

  test('malformed page or date values are reported first (INVALID_QUERY_PARAMETER), then the sort', async () => {
    expectErrorBody(await request(app).get(`${PATH}?page=0&sort=voltage`), 400, 'INVALID_QUERY_PARAMETER');
  });

  test('the sort is checked before the window order', async () => {
    expectErrorBody(await request(app).get(`${PATH}?sort=voltage&from=2026-10-06T12:00:00Z&to=2026-10-06T06:00:00Z`), 400, 'INVALID_SORT_FIELD');
  });

  test('a missing installation is 404 before the sort is checked', async () => {
    expectErrorBody(await request(app).get('/installations/INS-9999/readings?sort=voltage'), 404, 'INSTALLATION_NOT_FOUND');
  });
});
