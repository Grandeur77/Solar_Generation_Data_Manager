const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const District = require('../src/models/district');
const { generationSummary } = require('../src/services/summary-service');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Hand-computed from tests/fixtures/test-seed.js for the Sri Lanka day 2026-10-06.
// Combined power per 15-minute slot (peak = the highest; ties go to the earliest slot):
//   DT-01: 00:30Z 0 | 04:30Z 3 | 06:30Z 4 + 2 = 6 | 12:30Z 0.5 + 1 = 1.5   → peak 6 at 06:30Z
//   DT-02: 05:00Z 2.5 | 06:00Z 3                                          → peak 3 at 06:00Z
//   PV-01 (DT-01 + DT-02, no slot in common)                              → peak 6 at 06:30Z
// Registry (every registered installation, active or not):
//   DT-01: INS-0001 5 + INS-0002 3 + INS-0005 2 = 10 kW, 3 installations, 2 reported
//   DT-02: INS-0003 4 kW, 1 installation, 1 reported
//   DT-04 / PV-02: INS-0004 10 kW (inactive), 1 installation, 0 reported on 6 Oct
//   PV-01: 14 kW, 4 installations, 3 reported
// Utilisation = total_power_kw / installed_capacity_kw: DT-01 1.5/10 = 0.15, DT-02 3/4 = 0.75,
//   PV-01 4.5/14 = 0.3214… → 0.321
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const districtSummary = (id, query = '?date=2026-10-06') => request(app).get(`/districts/${id}/generation-summary${query}`);
const provinceSummary = (id, query = '?date=2026-10-06') => request(app).get(`/provinces/${id}/generation-summary${query}`);
const dt01Reading = (installation_id, timestamp, power_kw, energy_kwh) => ({
  installation_id, timestamp: new Date(timestamp), power_kw, energy_kwh, voltage: 230,
  substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01',
});

describe('the complete representation, against the hand-computed values', () => {
  beforeAll(loadTestSeed);

  test('DT-01 on 2026-10-06', async () => {
    const res = await districtSummary('DT-01');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      district_id: 'DT-01',
      date: '2026-10-06',
      total_power_kw: 1.5,
      power_as_of: '2026-10-06T12:30:00.000Z',
      day_energy_kwh: 30,
      peak_power_kw: 6,
      peak_at: '2026-10-06T06:30:00.000Z',
      installed_capacity_kw: 10,
      capacity_utilisation: 0.15,
      installation_count: 3,
      reporting_installations: 2,
    });
    // The field order is part of the contract that clients read.
    expect(Object.keys(res.body)).toEqual([
      'district_id', 'date', 'total_power_kw', 'power_as_of', 'day_energy_kwh', 'peak_power_kw', 'peak_at',
      'installed_capacity_kw', 'capacity_utilisation', 'installation_count', 'reporting_installations',
    ]);
  });

  test('DT-02 on 2026-10-06', async () => {
    expect((await districtSummary('DT-02')).body).toEqual({
      district_id: 'DT-02', date: '2026-10-06', total_power_kw: 3, power_as_of: '2026-10-06T06:00:00.000Z', day_energy_kwh: 2.75,
      peak_power_kw: 3, peak_at: '2026-10-06T06:00:00.000Z', installed_capacity_kw: 4, capacity_utilisation: 0.75,
      installation_count: 1, reporting_installations: 1,
    });
  });

  test('DT-04 on 2026-10-06: an inactive installation is still installed, but did not report', async () => {
    expect((await districtSummary('DT-04')).body).toEqual({
      district_id: 'DT-04', date: '2026-10-06', total_power_kw: 0, power_as_of: null, day_energy_kwh: 0,
      peak_power_kw: 0, peak_at: null, installed_capacity_kw: 10, capacity_utilisation: 0,
      installation_count: 1, reporting_installations: 0,
    });
  });

  test('PV-01 on 2026-10-06', async () => {
    const res = await provinceSummary('PV-01');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      province_id: 'PV-01', date: '2026-10-06', total_power_kw: 4.5, power_as_of: '2026-10-06T12:30:00.000Z', day_energy_kwh: 32.75,
      peak_power_kw: 6, peak_at: '2026-10-06T06:30:00.000Z', installed_capacity_kw: 14, capacity_utilisation: 0.321,
      installation_count: 4, reporting_installations: 3,
    });
    expect(Object.keys(res.body)[0]).toBe('province_id');
  });

  test('PV-02 on 2026-10-06 (nothing reported) and on 2026-10-02 (INS-0004 at 6 kW)', async () => {
    expect((await provinceSummary('PV-02')).body).toMatchObject({ total_power_kw: 0, peak_power_kw: 0, peak_at: null, installed_capacity_kw: 10, reporting_installations: 0 });
    expect((await provinceSummary('PV-02', '?date=2026-10-02')).body).toEqual({
      province_id: 'PV-02', date: '2026-10-02', total_power_kw: 6, power_as_of: '2026-10-02T06:30:00.000Z', day_energy_kwh: 0,
      peak_power_kw: 6, peak_at: '2026-10-02T06:30:00.000Z', installed_capacity_kw: 10, capacity_utilisation: 0.6,
      installation_count: 1, reporting_installations: 1,
    });
  });

  test('the province adds up its districts (same calculation, so they can never disagree)', async () => {
    const [dt01, dt02, pv01] = await Promise.all([districtSummary('DT-01'), districtSummary('DT-02'), provinceSummary('PV-01')]);
    for (const field of ['total_power_kw', 'day_energy_kwh', 'installed_capacity_kw', 'installation_count', 'reporting_installations']) {
      expect(pv01.body[field]).toBeCloseTo(dt01.body[field] + dt02.body[field], 3);
    }
  });
});

describe('peak power', () => {
  beforeEach(loadTestSeed);
  afterAll(loadTestSeed);

  test('a reading a few seconds off the 15-minute grid is added to its slot', async () => {
    // INS-0005 (no readings in the seed) reports at 06:30:20Z: slot 06:30 becomes 4 + 2 + 1.5 = 7.5.
    await GenerationReading.create(dt01Reading('INS-0005', '2026-10-06T06:30:20Z', 1.5, 100));
    expect((await districtSummary('DT-01')).body).toMatchObject({ peak_power_kw: 7.5, peak_at: '2026-10-06T06:30:00.000Z' });
  });

  test('two readings from one installation in the same slot are not added together', async () => {
    // INS-0001 has 4 kW at 06:30Z; another 4.2 kW at 06:35Z is the same slot. 4.2 + 2 = 6.2, not 4 + 4.2 + 2.
    await GenerationReading.create(dt01Reading('INS-0001', '2026-10-06T06:35:00Z', 4.2, 1013.5));
    expect((await districtSummary('DT-01')).body.peak_power_kw).toBe(6.2);
  });

  test('on a tie, the earliest slot is the peak', async () => {
    // INS-0003 at 05:45Z with 3 kW ties the existing 3 kW at 06:00Z.
    await GenerationReading.create({ ...dt01Reading('INS-0003', '2026-10-06T05:45:00Z', 3, 802), substation_id: 'SS-002', district_id: 'DT-02' });
    expect((await districtSummary('DT-02')).body).toMatchObject({ peak_power_kw: 3, peak_at: '2026-10-06T05:45:00.000Z' });
  });

  test('the peak is the highest slot of the day, not the latest', async () => {
    const { body } = await districtSummary('DT-01');
    expect(body.peak_power_kw).toBeGreaterThan(body.total_power_kw);
  });
});

describe('capacity and counts', () => {
  beforeEach(loadTestSeed);
  afterAll(loadTestSeed);

  test('a district with no installations: capacity 0, utilisation null (nothing to divide by)', async () => {
    await District.create({ _id: 'DT-05', name: 'Matale', province_id: 'PV-02' });
    expect((await districtSummary('DT-05')).body).toEqual({
      district_id: 'DT-05', date: '2026-10-06', total_power_kw: 0, power_as_of: null, day_energy_kwh: 0,
      peak_power_kw: 0, peak_at: null, installed_capacity_kw: 0, capacity_utilisation: null,
      installation_count: 0, reporting_installations: 0,
    });
  });

  // JSON.stringify writes NaN as null, so the HTTP body alone can't tell 0 ÷ 0 from a deliberate null.
  test('utilisation is a real null, not NaN from 0 ÷ 0 (checked before JSON hides the difference)', async () => {
    await District.create({ _id: 'DT-05', name: 'Matale', province_id: 'PV-02' });
    expect((await generationSummary({ district_id: 'DT-05' }, '2026-10-06')).capacity_utilisation).toBeNull();
  });

  test('a newly registered installation raises capacity and count, and lowers utilisation', async () => {
    const created = await request(app).post('/installations').send({
      installation_id: 'INS-0006', name: 'Kolonnawa test rooftop 6', meter_id: 'MTR-000006', substation_id: 'SS-001',
      capacity_kw: 5, status: 'active', commissioned_at: '2026-10-01T00:00:00Z', address: 'No. 6, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
    });
    expect(created.status).toBe(201);
    // 1.5 / 15 = 0.1
    expect((await districtSummary('DT-01')).body).toMatchObject({ installed_capacity_kw: 15, installation_count: 4, capacity_utilisation: 0.1, reporting_installations: 2 });
  });
});

describe('province summary: errors and conditional GET', () => {
  beforeAll(loadTestSeed);
  afterEach(() => jest.restoreAllMocks());

  test('a missing province → 404, checked before the date (even an invalid one)', async () => {
    expectErrorBody(await provinceSummary('PV-99'), 404, 'PROVINCE_NOT_FOUND');
    expectErrorBody(await provinceSummary('PV-99', '?date=nonsense'), 404, 'PROVINCE_NOT_FOUND');
  });

  test('an invalid or future ?date= → 400 INVALID_QUERY_PARAMETER on the date', async () => {
    for (const value of ['2026-02-30', '2100-01-01', '2026-10-06T00:00:00Z']) {
      const res = await provinceSummary('PV-01', `?date=${value}`);
      expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
      expect(res.body.details[0]).toMatchObject({ field: 'date', location: 'query' });
    }
  });

  test('no ?date= means today in Sri Lanka', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-05T18:45:00Z')); // 00:15 on 6 Oct in Sri Lanka
    expect((await provinceSummary('PV-01', '')).body).toMatchObject({ date: '2026-10-06', total_power_kw: 4.5 });
  });

  test('a strong ETag, no Last-Modified, and 304 for the same ETag', async () => {
    const first = await provinceSummary('PV-01');
    expect(first.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers['last-modified']).toBeUndefined();
    expect((await provinceSummary('PV-01').set('If-None-Match', first.headers.etag)).status).toBe(304);
  });
});
