const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Regressions for the Step 8.5 critique findings.
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const energy = async (district, date) => (await request(app).get(`/districts/${district}/generation-summary?date=${date}`)).body.day_energy_kwh;
const dt01Reading = (installation_id, timestamp, power_kw, energy_kwh) => ({
  installation_id, timestamp: new Date(timestamp), power_kw, energy_kwh, voltage: 230,
  substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01',
});
const storedTotals = async (id) => (await GenerationReading.find({ installation_id: id }).sort({ timestamp: 1 })).map((r) => r.energy_kwh);

// F2: a total that drops (meter replaced or reset) used to make every later day negative.
// Readings are created directly in the database here, as the seed or a data load would, because
// the API itself refuses a lower total.
describe('F2: a meter reset never gives negative energy', () => {
  beforeEach(loadTestSeed);
  afterAll(loadTestSeed);

  test('reset at the end of one day: later days count the new meter from its new total', async () => {
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-06T13:00:00Z', 0, 0)); // new meter, 18:30 SL on 6 Oct
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-07T04:30:00Z', 3, 5));
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-08T04:30:00Z', 3, 12));
    expect(await energy('DT-01', '2026-10-06')).toBe(30); // 20 + 10; the drop to 0 counts as 0
    expect(await energy('DT-01', '2026-10-07')).toBe(5); //  5 − 0   (was −1015 before the fix)
    expect(await energy('DT-01', '2026-10-08')).toBe(7); // 12 − 5   (was −1008 before the fix)
  });

  test('reset in the middle of a day: the increases before and after it are both counted', async () => {
    // INS-0001 on 6 Oct: 1000 → 1006 → 1013 → 1020 (+20), reset to 0, then 2 (+2). INS-0002 +10.
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-06T12:45:00Z', 0, 0));
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-06T13:00:00Z', 0.5, 2));
    expect(await energy('DT-01', '2026-10-06')).toBe(32);
  });

  test('the hand-computed values are unchanged: DT-01 30, DT-02 2.75 (first reading ever counts 0)', async () => {
    expect(await energy('DT-01', '2026-10-06')).toBe(30);
    expect(await energy('DT-02', '2026-10-06')).toBe(2.75);
  });
});

// F1: two POSTs at the same moment could both pass the energy check and store a decreasing total.
describe('F1: racing readings can never leave a decreasing total', () => {
  beforeEach(loadTestSeed);
  afterEach(() => jest.restoreAllMocks());
  afterAll(loadTestSeed);

  // Makes another request's reading land exactly between our check and our insert.
  function landBeforeOurInsert(other) {
    const realCreate = GenerationReading.create.bind(GenerationReading);
    jest.spyOn(GenerationReading, 'create').mockImplementationOnce(async (doc) => {
      await GenerationReading.collection.insertOne({ received_at: new Date(), ...other });
      return realCreate(doc);
    });
  }

  test('a later reading with a lower total lands first: ours is taken back and refused (400)', async () => {
    landBeforeOurInsert({ _id: '0000000000000000000000c1', ...dt01Reading('INS-0001', '2026-10-06T13:00:00Z', 0.3, 1025) });
    const res = await request(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.4, energy_kwh: 1030, voltage: 230 });
    expectErrorBody(res, 400, 'READING_IMPLAUSIBLE');
    expect(res.body.details).toEqual([
      expect.objectContaining({ field: 'energy_kwh', location: 'body', reference: '/installations/INS-0001/readings/0000000000000000000000c1' }),
    ]);
    expect(await storedTotals('INS-0001')).toEqual([1000, 1000, 1006, 1013, 1020, 1025]);
  });

  test('an earlier reading with a higher total lands first: ours is taken back and refused (400)', async () => {
    landBeforeOurInsert({ _id: '0000000000000000000000c2', ...dt01Reading('INS-0001', '2026-10-06T12:45:00Z', 0.4, 1030) });
    const res = await request(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T13:00:00Z', power_kw: 0.3, energy_kwh: 1025, voltage: 230 });
    expectErrorBody(res, 400, 'READING_IMPLAUSIBLE');
    expect(await storedTotals('INS-0001')).toEqual([1000, 1000, 1006, 1013, 1020, 1030]);
  });

  test('a neighbour that agrees with ours: both are kept (201)', async () => {
    landBeforeOurInsert({ _id: '0000000000000000000000c3', ...dt01Reading('INS-0001', '2026-10-06T13:00:00Z', 0.3, 1035) });
    const res = await request(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.4, energy_kwh: 1030, voltage: 230 });
    expect(res.status).toBe(201);
    expect(await storedTotals('INS-0001')).toEqual([1000, 1000, 1006, 1013, 1020, 1030, 1035]);
  });

  test('real parallel requests, repeated: the stored totals never decrease', async () => {
    for (let round = 0; round < 10; round++) {
      await loadTestSeed();
      const results = await Promise.all([
        request(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.4, energy_kwh: 1030, voltage: 230 }),
        request(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T13:00:00Z', power_kw: 0.3, energy_kwh: 1025, voltage: 230 }),
      ]);
      for (const res of results) expect([201, 400]).toContain(res.status);
      const totals = await storedTotals('INS-0001');
      expect(totals).toEqual([...totals].sort((a, b) => a - b));
    }
  });
});

// F3: other methods on a summary used to be 404 ROUTE_NOT_FOUND.
describe('F3: a summary is read-only → 405 with Allow', () => {
  beforeAll(loadTestSeed);

  for (const path of ['/districts/DT-01/generation-summary', '/provinces/PV-01/generation-summary']) {
    test.each(['post', 'put', 'patch', 'delete'])(`%s ${path} → 405, Allow: GET, HEAD`, async (method) => {
      const res = await request(app)[method](path).send({});
      expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
      expect(res.headers.allow).toBe('GET, HEAD');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  }

  test('GET still works, and OPTIONS is not turned into 405', async () => {
    expect((await request(app).get('/districts/DT-01/generation-summary?date=2026-10-06')).status).toBe(200);
    expect((await request(app).options('/districts/DT-01/generation-summary')).status).not.toBe(405);
  });
});

// F6: a day with no generation used to report "peak 0 kW at 23:45".
describe('F6: no generation means no peak time', () => {
  beforeAll(loadTestSeed);

  test('DT-01 on 2026-10-05 (only 0 kW readings): peak 0, peak_at null', async () => {
    const { body } = await request(app).get('/districts/DT-01/generation-summary?date=2026-10-05');
    expect(body).toMatchObject({ peak_power_kw: 0, peak_at: null, power_as_of: '2026-10-05T18:15:00.000Z', reporting_installations: 2 });
  });

  test('a day with generation still has its peak and time', async () => {
    expect((await request(app).get('/provinces/PV-02/generation-summary?date=2026-10-02')).body).toMatchObject({ peak_power_kw: 6, peak_at: '2026-10-02T06:30:00.000Z' });
  });
});
