const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { CAPACITY_TOLERANCE, MIN_VOLTAGE, MAX_VOLTAGE } = require('../src/utils/reading-rules');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001: 5 kW. Readings by time: …003 04:30Z 1006 kWh, …004 06:30Z 1013 kWh, …005 12:30Z 1020 kWh.
// INS-0005: 2 kW, no readings.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const R = (n) => n.toString(16).padStart(24, '0');
const OK = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 };
const post = (id, body) => request(app).post(`/installations/${id}/readings`).send(body);

async function expectImplausible(res, fields) {
  expectErrorBody(res, 400, 'READING_IMPLAUSIBLE');
  expect(res.body.details.map((d) => d.field)).toEqual(fields);
  res.body.details.forEach((d) => {
    expect(d.location).toBe('body');
    expect(d.issue.length).toBeGreaterThan(20); // a precise explanation, not just "invalid"
  });
}

describe('power_kw ≤ capacity_kw × tolerance', () => {
  test('exactly capacity × tolerance (5 × 1.1 = 5.5 kW) is accepted', async () => {
    expect(CAPACITY_TOLERANCE).toBe(1.1);
    expect((await post('INS-0001', { ...OK, power_kw: 5.5 })).status).toBe(201);
  });

  test('above it → 400, explaining the limit and pointing at the installation', async () => {
    const res = await post('INS-0001', { ...OK, power_kw: 5.51 });
    await expectImplausible(res, ['power_kw']);
    expect(res.body.details[0].issue).toContain('5.5 kW');
    expect(res.body.details[0].reference).toBe('/installations/INS-0001');
  });

  test('the limit is per installation: 3 kW is fine for 5 kW INS-0001 but not for 2 kW INS-0005', async () => {
    expect((await post('INS-0001', { ...OK, power_kw: 3 })).status).toBe(201);
    await expectImplausible(await post('INS-0005', { ...OK, power_kw: 3 }), ['power_kw']);
  });
});

describe('energy_kwh never decreases', () => {
  test('lower than the previous reading → 400 referencing that reading', async () => {
    const res = await post('INS-0001', { ...OK, energy_kwh: 1019.9 });
    await expectImplausible(res, ['energy_kwh']);
    expect(res.body.details[0].reference).toBe(`/installations/INS-0001/readings/${R(5)}`);
    expect(res.body.details[0].issue).toContain('1020');
  });

  test('equal to the previous reading (no generation, e.g. at night) is accepted', async () => {
    expect((await post('INS-0001', { ...OK, power_kw: 0, energy_kwh: 1020 })).status).toBe(201);
  });

  test('a late reading between two others is checked against both neighbours by time', async () => {
    // Between …004 (06:30Z, 1013) and …005 (12:30Z, 1020).
    const between = { ...OK, timestamp: '2026-10-06T09:00:00Z', power_kw: 4 };
    expect((await post('INS-0001', { ...between, energy_kwh: 1015 })).status).toBe(201);

    const tooLow = await post('INS-0001', { ...between, timestamp: '2026-10-06T09:15:00Z', energy_kwh: 1010 });
    await expectImplausible(tooLow, ['energy_kwh']);
    expect(tooLow.body.details[0].issue).toContain('previous');

    const tooHigh = await post('INS-0001', { ...between, timestamp: '2026-10-06T09:30:00Z', energy_kwh: 1025 });
    await expectImplausible(tooHigh, ['energy_kwh']);
    expect(tooHigh.body.details[0].issue).toContain('next');
    expect(tooHigh.body.details[0].reference).toBe(`/installations/INS-0001/readings/${R(5)}`);
  });

  test('an installation with no earlier reading accepts any energy total', async () => {
    expect((await post('INS-0005', { ...OK, power_kw: 1, energy_kwh: 5 })).status).toBe(201);
  });
});

describe('timestamp not in the future beyond the clock skew', () => {
  test('2 minutes ahead of the server clock is accepted (within skew)', async () => {
    const ts = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    expect((await post('INS-0005', { ...OK, power_kw: 1, timestamp: ts })).status).toBe(201);
  });

  test('10 minutes ahead → 400', async () => {
    const ts = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await post('INS-0005', { ...OK, power_kw: 1, timestamp: ts });
    await expectImplausible(res, ['timestamp']);
    expect(res.body.details[0].issue).toContain('future');
  });
});

describe('voltage in the plausible range', () => {
  test.each([MIN_VOLTAGE, MAX_VOLTAGE])('%s V (a boundary) is accepted', async (voltage) => {
    expect((await post('INS-0001', { ...OK, voltage })).status).toBe(201);
  });

  test.each([150, 179.9, 270.1, 400, 0])('%s V → 400', async (voltage) => {
    const res = await post('INS-0001', { ...OK, voltage });
    await expectImplausible(res, ['voltage']);
    expect(res.body.details[0].issue).toContain('180–270 V');
  });
});

describe('how plausibility fits with the other checks', () => {
  test('several broken rules are all reported at once', async () => {
    const res = await post('INS-0001', { ...OK, power_kw: 9, energy_kwh: 1, voltage: 150 });
    await expectImplausible(res, ['power_kw', 'energy_kwh', 'voltage']);
  });

  test('nothing is stored when a reading is refused', async () => {
    await post('INS-0001', { ...OK, voltage: 400 });
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001' })).toBe(5);
  });

  test('structural errors come first: a negative power is VALIDATION_FAILED, not READING_IMPLAUSIBLE', async () => {
    expectErrorBody(await post('INS-0001', { ...OK, power_kw: -1 }), 400, 'VALIDATION_FAILED');
  });

  test('an unknown installation is still 404, not a plausibility error', async () => {
    expectErrorBody(await post('INS-9999', { ...OK, power_kw: 999 }), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('an identical device retry is still 409, not 400 (the stored reading is not its own neighbour)', async () => {
    const existing = { timestamp: '2026-10-06T12:30:00Z', power_kw: 0.5, energy_kwh: 1020, voltage: 230.2 };
    expectErrorBody(await post('INS-0001', existing), 409, 'READING_DUPLICATE');
  });
});
