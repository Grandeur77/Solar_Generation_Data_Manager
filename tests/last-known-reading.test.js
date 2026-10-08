const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase, seed } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture: INS-0001 newest reading is 000…005 (2026-10-06T12:30Z); INS-0004 (inactive) has one
// old reading 000…00b; INS-0005 exists with no readings; INS-9999 does not exist.
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const get = (id) => request(app).get(`/installations/${id}/last-known-reading`);

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

describe('GET /installations/{installation-id}/last-known-reading', () => {
  test('returns the newest reading, reading fields only', async () => {
    const res = await get('INS-0001');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(readingJson('000000000000000000000005'));
  });

  test('carries no installation metadata and no wrapper', async () => {
    const res = await get('INS-0001');
    for (const key of ['name', 'meter_id', 'capacity_kw', 'status', 'address', 'last_reading', 'substation_id', 'district_id', 'province_id']) {
      expect(res.body).not.toHaveProperty(key);
    }
  });

  test('matches the composite\'s last_reading exactly (one shared helper, so they cannot disagree)', async () => {
    const [processing, composite] = await Promise.all([get('INS-0001'), request(app).get('/installations/INS-0001')]);
    expect(processing.body).toEqual(composite.body.last_reading);
  });

  test('an inactive installation returns the last reading it sent before stopping', async () => {
    const res = await get('INS-0004');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readingJson('00000000000000000000000b'));
  });

  test('installation exists but has no readings → 404 NO_READINGS_YET', async () => {
    const res = await get('INS-0005');
    expectErrorBody(res, 404, 'NO_READINGS_YET');
    expect(res.body.message).toContain('INS-0005');
  });

  test('installation does not exist → 404 INSTALLATION_NOT_FOUND (a different code)', async () => {
    const res = await get('INS-9999');
    expectErrorBody(res, 404, 'INSTALLATION_NOT_FOUND');
    expect(res.body.message).toContain('INS-9999');
  });

  test('a malformed installation id → 404 INSTALLATION_NOT_FOUND, not a server error', async () => {
    expectErrorBody(await get('not-an-id'), 404, 'INSTALLATION_NOT_FOUND');
  });

  describe('a late-arriving older reading', () => {
    afterAll(loadTestSeed);

    test('does not become the last-known reading', async () => {
      const i = seed.installations.find((x) => x.installation_id === 'INS-0001');
      await GenerationReading.create({
        _id: 'ffffffffffffffffffffffff',
        installation_id: 'INS-0001',
        timestamp: '2026-10-04T06:00:00Z',
        power_kw: 4.5,
        energy_kwh: 990,
        voltage: 231,
        received_at: '2026-10-06T13:00:00Z',
        substation_id: i.substation_id,
        district_id: i.district_id,
        province_id: i.province_id,
      });
      expect((await get('INS-0001')).body.reading_id).toBe('000000000000000000000005');
    });
  });

  test('Accept: text/html → 406', async () => {
    expectErrorBody(await get('INS-0001').set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
  });
});
