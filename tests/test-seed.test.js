// Guards the test fixture itself: if someone edits it, the hand-computed values in
// tests/fixtures/test-seed.js must be updated too, or this file fails.
const bcrypt = require('bcryptjs');
const { setUpTestDatabase, tearDownTestDatabase, seed } = require('./helpers/test-db');
const GenerationReading = require('../src/models/generation-reading');
const SolarInstallation = require('../src/models/solar-installation');
const User = require('../src/models/user');
const Province = require('../src/models/province');
const District = require('../src/models/district');
const GridSubstation = require('../src/models/grid-substation');

beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const latest = (installation_id) => GenerationReading.findOne({ installation_id }).sort({ timestamp: -1 });
// The last reading before the Sri Lanka day 2026-10-06 begins (00:00 SL = 2026-10-05T18:30:00Z).
const dayStart = new Date('2026-10-05T18:30:00Z');
const baseline = (installation_id) =>
  GenerationReading.findOne({ installation_id, timestamp: { $lt: dayStart } }).sort({ timestamp: -1 });

describe('test seed', () => {
  test('loads the expected counts', async () => {
    expect(await Province.countDocuments()).toBe(2);
    expect(await District.countDocuments()).toBe(3);
    expect(await GridSubstation.countDocuments()).toBe(3);
    expect(await SolarInstallation.countDocuments()).toBe(5);
    expect(await GenerationReading.countDocuments()).toBe(11);
    expect(await User.countDocuments()).toBe(7);
  });

  test('every parent id resolves and every reading copies its installation', async () => {
    const ids = (list, field) => new Set(list.map((r) => r[field]));
    const provinces = ids(seed.provinces, 'province_id');
    const districts = ids(seed.districts, 'district_id');
    const substations = new Map(seed.substations.map((s) => [s.substation_id, s]));
    const installations = new Map(seed.installations.map((i) => [i.installation_id, i]));

    seed.districts.forEach((d) => expect(provinces.has(d.province_id)).toBe(true));
    seed.installations.forEach((i) => {
      expect(substations.get(i.substation_id).district_id).toBe(i.district_id);
      expect(districts.has(i.district_id)).toBe(true);
    });
    seed.readings.forEach((r) => {
      const i = installations.get(r.installation_id);
      expect([r.substation_id, r.district_id, r.province_id]).toEqual([i.substation_id, i.district_id, i.province_id]);
    });
  });

  test('energy_kwh never decreases per installation', () => {
    const byInstallation = {};
    for (const r of [...seed.readings].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      const previous = byInstallation[r.installation_id];
      if (previous !== undefined) expect(r.energy_kwh).toBeGreaterThanOrEqual(previous);
      byInstallation[r.installation_id] = r.energy_kwh;
    }
  });

  test('latest readings match the hand-computed values', async () => {
    const one = await latest('INS-0001');
    const two = await latest('INS-0002');
    expect(one.toJSON()).toMatchObject({ reading_id: '000000000000000000000005', power_kw: 0.5, energy_kwh: 1020 });
    expect(two.toJSON()).toMatchObject({ reading_id: '000000000000000000000008', power_kw: 1, energy_kwh: 510 });
    expect(one.power_kw + two.power_kw).toBe(1.5); // DT-01 current total power
    expect(await latest('INS-0005')).toBeNull(); // no readings
  });

  test('Colombo-day baselines give the hand-computed day energy', async () => {
    const dt01 = (1020 - (await baseline('INS-0001')).energy_kwh) + (510 - (await baseline('INS-0002')).energy_kwh);
    expect(dt01).toBe(30);
    expect(await baseline('INS-0003')).toBeNull(); // DT-02: first reading of the day is the baseline
  });

  test('credentials verify against their hashes and the unique index is in place', async () => {
    const user = await User.findById('USR-004').select('+password_hash');
    expect(await bcrypt.compare('test-colombo-pass', user.password_hash)).toBe(true);
    const site = await SolarInstallation.findById('INS-0001').select('+device_secret_hash');
    expect(await bcrypt.compare(seed.deviceSecrets['INS-0001'], site.device_secret_hash)).toBe(true);

    const r = seed.readings[0];
    await expect(
      GenerationReading.create({ ...r, _id: undefined, reading_id: undefined, power_kw: 9 })
    ).rejects.toMatchObject({ code: 11000 });
  });
});
