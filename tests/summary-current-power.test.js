const GenerationReading = require('../src/models/generation-reading');
const { currentTotalPower } = require('../src/services/summary-service');
const { sriLankaDay, sriLankaToday } = require('../src/utils/sri-lanka-day');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');

// Hand-computed in Step 8.1 from tests/fixtures/test-seed.js (Sri Lanka day 2026-10-06):
//   DT-01: INS-0001 latest 0.5 kW + INS-0002 latest 1.0 kW = 1.5 kW, newest at 12:30Z (INS-0005 has none)
//   DT-02: INS-0003 latest 3 kW at 06:00Z
//   DT-04: INS-0004's only reading is on 2 Oct, so it did not report on 6 Oct → 0, null
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const power = (district, date) => currentTotalPower({ district_id: district }, sriLankaDay(date));

describe('the Sri Lanka day', () => {
  test('2026-10-06 is [2026-10-05T18:30Z, 2026-10-06T18:30Z), not the UTC day', () => {
    const { start, end } = sriLankaDay('2026-10-06');
    expect(start.toISOString()).toBe('2026-10-05T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-06T18:30:00.000Z');
  });

  test('today switches at 18:30Z (Sri Lanka midnight), not at 00:00Z', () => {
    expect(sriLankaToday(new Date('2026-10-05T18:29:59Z'))).toBe('2026-10-05');
    expect(sriLankaToday(new Date('2026-10-05T18:30:00Z'))).toBe('2026-10-06');
    expect(sriLankaToday(new Date('2026-10-06T00:00:00Z'))).toBe('2026-10-06');
  });
});

describe('current total power against the hand-computed values', () => {
  beforeAll(loadTestSeed);

  test('DT-01 on 2026-10-06: 0.5 + 1.0 = 1.5 kW, as of 12:30Z', async () => {
    expect(await power('DT-01', '2026-10-06')).toEqual({ total_power_kw: 1.5, power_as_of: new Date('2026-10-06T12:30:00Z'), reporting_installations: 2 });
  });

  test('DT-02 on 2026-10-06: 3 kW, as of 06:00Z', async () => {
    expect(await power('DT-02', '2026-10-06')).toEqual({ total_power_kw: 3, power_as_of: new Date('2026-10-06T06:00:00Z'), reporting_installations: 1 });
  });

  test('DT-04 on 2026-10-06: an installation that stopped reporting adds nothing → 0, null', async () => {
    expect(await power('DT-04', '2026-10-06')).toEqual({ total_power_kw: 0, power_as_of: null, reporting_installations: 0 });
  });

  test('DT-04 on 2026-10-02, the day it did report: 6 kW', async () => {
    expect(await power('DT-04', '2026-10-02')).toEqual({ total_power_kw: 6, power_as_of: new Date('2026-10-02T06:30:00Z'), reporting_installations: 1 });
  });

  test('DT-01 on 2026-10-05: the 23:45 Sri Lanka readings (18:15Z) belong to 5 Oct → 0 kW as of 18:15Z', async () => {
    expect(await power('DT-01', '2026-10-05')).toEqual({ total_power_kw: 0, power_as_of: new Date('2026-10-05T18:15:00Z'), reporting_installations: 2 });
  });

  test('a day with no readings → 0, null', async () => {
    expect(await power('DT-01', '2026-10-07')).toEqual({ total_power_kw: 0, power_as_of: null, reporting_installations: 0 });
  });

  test('an unknown district → 0, null (the 404 belongs to the route)', async () => {
    expect(await power('DT-99', '2026-10-06')).toEqual({ total_power_kw: 0, power_as_of: null, reporting_installations: 0 });
  });
});

describe('latest means newest by timestamp, and the work happens in MongoDB', () => {
  beforeEach(loadTestSeed);
  // Restore spies even when a test fails, so one failure never leaks into the next test.
  afterEach(() => jest.restoreAllMocks());
  afterAll(loadTestSeed);

  test('a late-arriving older reading does not replace the latest one', async () => {
    // Stored last, but measured at 10:00Z, before INS-0001's 12:30Z reading.
    await GenerationReading.create({
      installation_id: 'INS-0001', timestamp: new Date('2026-10-06T10:00:00Z'), power_kw: 4.5, energy_kwh: 1016, voltage: 231,
      substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01',
    });
    expect((await power('DT-01', '2026-10-06')).total_power_kw).toBe(1.5);
  });

  test('a newer reading replaces the latest one', async () => {
    await GenerationReading.create({
      installation_id: 'INS-0001', timestamp: new Date('2026-10-06T12:45:00Z'), power_kw: 0.25, energy_kwh: 1020.1, voltage: 230,
      substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01',
    });
    expect(await power('DT-01', '2026-10-06')).toEqual({ total_power_kw: 1.25, power_as_of: new Date('2026-10-06T12:45:00Z'), reporting_installations: 2 });
  });

  test('the sum is rounded to 3 dp: 0.1 + 0.2 is 0.3, not 0.30000000000000004', async () => {
    const at = new Date('2026-10-06T12:45:00Z');
    const common = { timestamp: at, voltage: 230, substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-01' };
    await GenerationReading.create({ ...common, installation_id: 'INS-0001', power_kw: 0.1, energy_kwh: 1020.1 });
    await GenerationReading.create({ ...common, installation_id: 'INS-0002', power_kw: 0.2, energy_kwh: 510.1 });
    expect((await power('DT-01', '2026-10-06')).total_power_kw).toBe(0.3);
  });

  // With the { district_id, timestamp: -1 } index, MongoDB happens to hand $group the newest
  // reading first even with no $sort, so the results alone can't prove the sort is there.
  // This checks the pipeline itself sorts newest-first right before taking $first.
  test('sorts newest-first explicitly before the per-installation $group (never relies on index order)', async () => {
    const aggregate = jest.spyOn(GenerationReading, 'aggregate');
    await power('DT-01', '2026-10-06');
    const stages = aggregate.mock.calls[0][0];
    const groupAt = stages.findIndex((s) => s.$group && s.$group._id === '$installation_id');
    expect(stages[groupAt - 1]).toEqual({ $sort: { installation_id: 1, timestamp: -1 } });
  });

  test('one aggregation call, and no readings are fetched into Node', async () => {
    const aggregate = jest.spyOn(GenerationReading, 'aggregate');
    const find = jest.spyOn(GenerationReading, 'find');
    await power('DT-01', '2026-10-06');
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
  });
});
