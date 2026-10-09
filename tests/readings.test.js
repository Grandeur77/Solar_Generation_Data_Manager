const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, tearDownTestDatabase, seed } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture: INS-0001 has readings 000…001 to 000…005 (oldest to newest); INS-0002 has 000…006
// to 000…008; INS-0005 exists with no readings; INS-9999 does not exist.
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const get = (path) => request(app).get(path);
const R = (n) => n.toString(16).padStart(24, '0'); // R(3) -> '000000000000000000000003'

const readingJson = (id) => {
  const { reading_id, installation_id, timestamp, power_kw, energy_kwh, voltage, received_at } = seed.readings.find(
    (r) => r.reading_id === id
  );
  return {
    reading_id,
    installation_id,
    timestamp: new Date(timestamp).toISOString(),
    power_kw,
    energy_kwh,
    voltage,
    received_at: new Date(received_at).toISOString(),
  };
};

describe('GET /installations/{installation-id}/readings', () => {
  // Paged since Step 7.1; the page edges are tested in readings-pagination.test.js.
  test('returns the installation\'s readings, newest first, in the page object', async () => {
    const res = await get('/installations/INS-0001/readings');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({ count: 5, next: null, previous: null });
    expect(res.body.results.map((r) => r.reading_id)).toEqual([R(5), R(4), R(3), R(2), R(1)]);
  });

  test('each item is the reading shape exactly: no copied jurisdiction ids, no _id or __v', async () => {
    const res = await get('/installations/INS-0001/readings');
    expect(res.body.results[0]).toEqual(readingJson(R(5)));
    expect(res.body.results).toEqual([R(5), R(4), R(3), R(2), R(1)].map(readingJson));
  });

  test('is scoped: only this installation\'s readings, never another\'s', async () => {
    const res = await get('/installations/INS-0002/readings');
    expect(res.body.results.map((r) => r.reading_id)).toEqual([R(8), R(7), R(6)]);
    res.body.results.forEach((r) => expect(r.installation_id).toBe('INS-0002'));
  });

  test('installation exists but has no readings → 200 with count 0 and empty results', async () => {
    const res = await get('/installations/INS-0005/readings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, next: null, previous: null, results: [] });
  });

  test('missing parent installation → 404 INSTALLATION_NOT_FOUND', async () => {
    expectErrorBody(await get('/installations/INS-9999/readings'), 404, 'INSTALLATION_NOT_FOUND');
  });
});

describe('GET /installations/{installation-id}/readings/{reading-id}', () => {
  test('returns the reading', async () => {
    const res = await get(`/installations/INS-0001/readings/${R(3)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readingJson(R(3)));
  });

  test('a real reading under the wrong installation → 404 READING_NOT_FOUND (the scope holds)', async () => {
    // R(3) belongs to INS-0001, not INS-0002.
    const res = await get(`/installations/INS-0002/readings/${R(3)}`);
    expectErrorBody(res, 404, 'READING_NOT_FOUND');
  });

  test('unknown reading under an existing installation → 404 READING_NOT_FOUND', async () => {
    expectErrorBody(await get(`/installations/INS-0001/readings/${'f'.repeat(24)}`), 404, 'READING_NOT_FOUND');
  });

  test('malformed reading id → 404, not a server error', async () => {
    expectErrorBody(await get('/installations/INS-0001/readings/not-an-id'), 404, 'READING_NOT_FOUND');
  });

  test('missing parent installation → 404 INSTALLATION_NOT_FOUND, even for a real reading id', async () => {
    expectErrorBody(await get(`/installations/INS-9999/readings/${R(3)}`), 404, 'INSTALLATION_NOT_FOUND');
  });
});

describe('there is no top-level readings collection', () => {
  test.each(['/readings', '/readings?installation-id=INS-0001', `/readings/${R(3)}`])('%s → 404 ROUTE_NOT_FOUND', async (path) => {
    expectErrorBody(await get(path), 404, 'ROUTE_NOT_FOUND');
  });
});

describe('content negotiation', () => {
  test('Accept: text/html → 406', async () => {
    expectErrorBody(await get('/installations/INS-0001/readings').set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
  });
});
