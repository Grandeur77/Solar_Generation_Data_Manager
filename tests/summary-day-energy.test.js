const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { dayEnergy } = require('../src/services/summary-service');
const { sriLankaDay } = require('../src/utils/sri-lanka-day');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Hand-computed in Step 8.1 from tests/fixtures/test-seed.js. The Sri Lanka day 2026-10-06 is
// [2026-10-05T18:30Z, 2026-10-06T18:30Z).
//   DT-01: INS-0001 1020 − 1000 (its 23:45 reading on 5 Oct) = 20
//          INS-0002  510 −  500 (its 23:45 reading on 5 Oct) = 10     → 30 kWh, 1.5 kW
//   DT-02: INS-0003 802.75 − 800 (nothing earlier: the day's first)   → 2.75 kWh, 3 kW
//   DT-04: INS-0004 last reported on 2 Oct                            → 0 kWh, 0 kW, power_as_of null
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const summary = (district, query = '') => request(app).get(`/districts/${district}/generation-summary${query}`);
// Fixes "now" for the default day. Only Date.now is replaced, so timers keep working.
const setNow = (iso) => jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
const reading = (installation_id, timestamp, power_kw, energy_kwh) => ({
  installation_id, timestamp: new Date(timestamp), power_kw, energy_kwh, voltage: 230,
  substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01',
});

describe('GET /districts/{district-id}/generation-summary?date= against the hand-computed values', () => {
  beforeAll(loadTestSeed);

  test('DT-01 on 2026-10-06: 1.5 kW now, 30 kWh today (full representation: summary-extras-province.test.js)', async () => {
    const res = await summary('DT-01', '?date=2026-10-06');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      district_id: 'DT-01',
      date: '2026-10-06',
      total_power_kw: 1.5,
      power_as_of: '2026-10-06T12:30:00.000Z',
      day_energy_kwh: 30,
    });
  });

  test('DT-02 on 2026-10-06: no reading before the day, so its first reading is the baseline → 2.75 kWh', async () => {
    expect((await summary('DT-02', '?date=2026-10-06')).body).toMatchObject({
      district_id: 'DT-02', date: '2026-10-06', total_power_kw: 3, power_as_of: '2026-10-06T06:00:00.000Z', day_energy_kwh: 2.75,
    });
  });

  test('DT-04 on 2026-10-06: nothing reported that day → zeros and null, still 200', async () => {
    const res = await summary('DT-04', '?date=2026-10-06');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ district_id: 'DT-04', date: '2026-10-06', total_power_kw: 0, power_as_of: null, day_energy_kwh: 0 });
  });

  test('DT-04 on 2026-10-02: one reading, which is its own baseline → 6 kW, 0 kWh', async () => {
    expect((await summary('DT-04', '?date=2026-10-02')).body).toMatchObject({ total_power_kw: 6, day_energy_kwh: 0 });
  });

  test('DT-01 on 2026-10-05: only the 23:45 Sri Lanka readings (18:15Z) are in that day → 0 kWh', async () => {
    expect((await summary('DT-01', '?date=2026-10-05')).body).toMatchObject({
      district_id: 'DT-01', date: '2026-10-05', total_power_kw: 0, power_as_of: '2026-10-05T18:15:00.000Z', day_energy_kwh: 0,
    });
  });

  test('DT-01 on 2026-10-07: no readings → zeros and null', async () => {
    expect((await summary('DT-01', '?date=2026-10-07')).body).toMatchObject({ total_power_kw: 0, power_as_of: null, day_energy_kwh: 0 });
  });
});

describe('the default day is today in Sri Lanka', () => {
  beforeAll(loadTestSeed);
  afterEach(() => jest.restoreAllMocks());

  test('at 2026-10-06T13:00Z (18:30 Sri Lanka), no ?date= means 2026-10-06', async () => {
    setNow('2026-10-06T13:00:00Z');
    expect((await summary('DT-01')).body).toMatchObject({ date: '2026-10-06', total_power_kw: 1.5, day_energy_kwh: 30 });
  });

  test('at 2026-10-05T18:45Z it is already 6 Oct in Sri Lanka (00:15), though still 5 Oct in UTC', async () => {
    setNow('2026-10-05T18:45:00Z');
    expect((await summary('DT-01')).body.date).toBe('2026-10-06');
  });

  test('today itself is allowed as ?date=; tomorrow is 400', async () => {
    setNow('2026-10-06T13:00:00Z');
    expect((await summary('DT-01', '?date=2026-10-06')).status).toBe(200);
    const res = await summary('DT-01', '?date=2026-10-07');
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details).toEqual([{ field: 'date', location: 'query', issue: 'Must not be after today in Sri Lanka (2026-10-06).', reference: null }]);
  });
});

describe('day energy follows the cumulative meter total', () => {
  beforeEach(loadTestSeed);
  afterAll(loadTestSeed);

  test('a newer reading raises the day total; the sum is rounded (1020.1 − 1000 + 10 = 30.1, not 30.100000000000023)', async () => {
    await GenerationReading.create(reading('INS-0001', '2026-10-06T12:45:00Z', 0.2, 1020.1));
    expect((await summary('DT-01', '?date=2026-10-06')).body.day_energy_kwh).toBe(30.1);
  });

  test('a late-arriving older reading does not change the day total', async () => {
    await GenerationReading.create(reading('INS-0001', '2026-10-06T10:00:00Z', 4.5, 1016));
    expect((await summary('DT-01', '?date=2026-10-06')).body.day_energy_kwh).toBe(30);
  });

  test('a reading exactly at Sri Lanka midnight (18:30Z) belongs to the new day, not the old one', async () => {
    await GenerationReading.create(reading('INS-0002', '2026-10-05T18:30:00Z', 0, 501));
    // 6 Oct: INS-0002 is 510 − 500 (baseline still the 23:45 reading) = 10, so DT-01 stays 30.
    expect((await summary('DT-01', '?date=2026-10-06')).body.day_energy_kwh).toBe(30);
    // 5 Oct ends at 18:30Z exclusive, so the 18:30Z reading is not in it: still 0.
    expect((await summary('DT-01', '?date=2026-10-05')).body.day_energy_kwh).toBe(0);
  });

  test('the baseline is the last reading before the day, however many days earlier it was', async () => {
    // INS-0004 last reported on 2 Oct at 2000 kWh; it comes back on 6 Oct at 2030 kWh.
    await GenerationReading.create({ ...reading('INS-0004', '2026-10-06T06:30:00Z', 5, 2030), substation_id: 'SS-003', district_id: 'DT-04', province_id: 'PV-02' });
    expect((await summary('DT-04', '?date=2026-10-06')).body).toMatchObject({ total_power_kw: 5, day_energy_kwh: 30 });
  });

  test('three aggregations over readings and no readings fetched into Node', async () => {
    const aggregate = jest.spyOn(GenerationReading, 'aggregate');
    const find = jest.spyOn(GenerationReading, 'find');
    await summary('DT-01', '?date=2026-10-06');
    expect(aggregate).toHaveBeenCalledTimes(3); // current power, day energy, peak power
    expect(find).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('dayEnergy on its own: DT-01 on 2026-10-06 is 30', async () => {
    expect(await dayEnergy({ district_id: 'DT-01' }, sriLankaDay('2026-10-06'))).toBe(30);
  });
});

describe('errors', () => {
  beforeAll(loadTestSeed);

  test.each(['2026-02-30', '2026-13-01', '2026-10-6', '06-10-2026', '2026-10-06T00:00:00Z', 'today', ''])(
    '?date=%s → 400 INVALID_QUERY_PARAMETER',
    async (value) => {
      const res = await summary('DT-01', `?date=${value}`);
      expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
      expect(res.body.details).toEqual([
        { field: 'date', location: 'query', issue: 'Must be a real calendar day as YYYY-MM-DD, given once.', reference: null },
      ]);
    }
  );

  test('?date= given twice → 400', async () => {
    expectErrorBody(await summary('DT-01', '?date=2026-10-06&date=2026-10-05'), 400, 'INVALID_QUERY_PARAMETER');
  });

  test('a date far in the future → 400', async () => {
    expectErrorBody(await summary('DT-01', '?date=2100-01-01'), 400, 'INVALID_QUERY_PARAMETER');
  });

  test('a missing district → 404, checked before the date (even an invalid one)', async () => {
    expectErrorBody(await summary('DT-99', '?date=2026-10-06'), 404, 'DISTRICT_NOT_FOUND');
    expectErrorBody(await summary('DT-99', '?date=nonsense'), 404, 'DISTRICT_NOT_FOUND');
  });
});

describe('conditional GET: ETag only', () => {
  beforeAll(loadTestSeed);
  afterAll(loadTestSeed);

  test('a strong ETag, no Last-Modified, and 304 for the same ETag', async () => {
    const first = await summary('DT-01', '?date=2026-10-06');
    expect(first.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers['last-modified']).toBeUndefined();
    const again = await summary('DT-01', '?date=2026-10-06').set('If-None-Match', first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text || '').toBe('');
  });

  test('If-Modified-Since never gives 304 (there is no date to compare)', async () => {
    expect((await summary('DT-01', '?date=2026-10-06').set('If-Modified-Since', 'Fri, 01 Jan 2100 00:00:00 GMT')).status).toBe(200);
  });

  test('a new reading in the district changes the ETag, so the old one gets 200', async () => {
    const first = await summary('DT-01', '?date=2026-10-06');
    await GenerationReading.create(reading('INS-0002', '2026-10-06T12:45:00Z', 0.8, 510.2));
    const res = await summary('DT-01', '?date=2026-10-06').set('If-None-Match', first.headers.etag);
    expect(res.status).toBe(200);
    expect(res.body.day_energy_kwh).toBe(30.2);
  });
});
