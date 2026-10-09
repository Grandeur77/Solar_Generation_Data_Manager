const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001's newest fixture reading is 000…005 at 2026-10-06T12:30:00Z (power 0.5, energy 1020).
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const NEW = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 };
const post = (id, body) => request(app).post(`/installations/${id}/readings`).send(body);
const R5 = '000000000000000000000005';

describe('duplicate reading → 409 READING_DUPLICATE', () => {
  test('posting the same reading twice: second is 409 and points at the first', async () => {
    const first = await post('INS-0001', NEW);
    expect(first.status).toBe(201);

    const second = await post('INS-0001', NEW);
    expectErrorBody(second, 409, 'READING_DUPLICATE');
    expect(second.body.details).toEqual([
      { field: 'timestamp', location: 'body', issue: expect.any(String), reference: first.headers.location },
    ]);
  });

  test('the reference resolves with GET to the existing reading', async () => {
    const res = await post('INS-0001', { timestamp: '2026-10-06T12:30:00Z', power_kw: 0.5, energy_kwh: 1020, voltage: 230.2 });
    expectErrorBody(res, 409, 'READING_DUPLICATE');
    const reference = res.body.details[0].reference;
    expect(reference).toBe(`/installations/INS-0001/readings/${R5}`);

    const existing = await request(app).get(reference);
    expect(existing.status).toBe(200);
    expect(existing.body.reading_id).toBe(R5);
  });

  test('append-only: a duplicate with different values does not overwrite the stored reading', async () => {
    const res = await post('INS-0001', { timestamp: '2026-10-06T12:30:00Z', power_kw: 4.9, energy_kwh: 9999, voltage: 240 });
    expect(res.status).toBe(409);

    const stored = await GenerationReading.findById(R5);
    expect([stored.power_kw, stored.energy_kwh, stored.voltage]).toEqual([0.5, 1020, 230.2]);
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001' })).toBe(5); // nothing added
  });

  test('the same instant written with a different offset is still a duplicate', async () => {
    // 18:00 Sri Lanka time is 12:30 UTC: the same moment as the stored reading.
    const res = await post('INS-0001', { timestamp: '2026-10-06T18:00:00+05:30', power_kw: 0.5, energy_kwh: 1020, voltage: 230.2 });
    expectErrorBody(res, 409, 'READING_DUPLICATE');
    expect(res.body.details[0].reference).toBe(`/installations/INS-0001/readings/${R5}`);
  });

  test('uniqueness is per installation: the same timestamp for another installation is fine', async () => {
    const res = await post('INS-0005', { timestamp: '2026-10-06T12:30:00Z', power_kw: 1, energy_kwh: 10, voltage: 231 });
    expect(res.status).toBe(201);
  });

  test('two identical posts at the same moment: exactly one is stored', async () => {
    const [a, b] = await Promise.all([post('INS-0001', NEW), post('INS-0001', NEW)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001', timestamp: new Date(NEW.timestamp) })).toBe(1);
  });
});

describe('PUT, PATCH or DELETE on a reading → 405 METHOD_NOT_ALLOWED', () => {
  const member = `/installations/INS-0001/readings/${R5}`;

  test.each(['put', 'patch', 'delete'])('%s on a reading → 405 with Allow: GET, HEAD', async (method) => {
    const res = await request(app)[method](member).send({ power_kw: 99 });
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  test('the reading is unchanged afterwards', async () => {
    await request(app).delete(member);
    await request(app).put(member).send({ power_kw: 99 });
    const res = await request(app).get(member);
    expect(res.status).toBe(200);
    expect(res.body.power_kw).toBe(0.5);
  });

  test.each(['put', 'patch', 'delete'])('%s on the readings collection → 405 with Allow: GET, HEAD, POST', async (method) => {
    const res = await request(app)[method]('/installations/INS-0001/readings').send([]);
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('GET, HEAD, POST');
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001' })).toBe(5); // history intact
  });

  test('405 depends only on the method, not on whether the ids exist', async () => {
    const res = await request(app).delete(`/installations/INS-9999/readings/${'f'.repeat(24)}`);
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
  });

  test('405 is answered without the database (it still works when the database is unreachable)', async () => {
    // A fresh copy of the app with its own, never-connected database module. db.js reads
    // MONGODB_URI when it first connects, so the URI must stay unreachable during the request.
    let isolatedApp;
    let isolatedMongoose;
    jest.isolateModules(() => {
      isolatedApp = require('../src/app');
      isolatedMongoose = require('mongoose');
    });
    const saved = process.env.MONGODB_URI;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unreachable';
    try {
      const started = Date.now();
      const res = await request(isolatedApp).delete(member);
      expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
      expect(Date.now() - started).toBeLessThan(1000); // no 5 s wait for a database
    } finally {
      process.env.MONGODB_URI = saved;
      quiet.mockRestore();
      await isolatedMongoose.disconnect(); // leave no open handle behind
    }
  });
});
