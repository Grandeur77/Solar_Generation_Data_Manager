const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { getLastReading } = require('../src/services/reading-service');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase, seed } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture readings: INS-0001 has 5 (oldest 000…001 at 2026-10-05T18:15Z, newest 000…005 at
// 2026-10-06T12:30Z); INS-0004 has one old reading (000…00b); INS-0005 has none.
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const installationPart = (id) => {
  const record = seed.installations.find((i) => i.installation_id === id);
  return { ...record, commissioned_at: new Date(record.commissioned_at).toISOString() };
};

// A reading exactly as the API shows it: no copied jurisdiction ids, no _id or __v.
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

describe('getLastReading()', () => {
  test('returns the newest reading by timestamp', async () => {
    const reading = await getLastReading('INS-0001');
    expect(reading.toJSON().reading_id).toBe('000000000000000000000005');
  });

  test('returns null when the installation has no readings', async () => {
    expect(await getLastReading('INS-0005')).toBeNull();
  });

  // With the { installation_id, timestamp: -1 } index, MongoDB happens to return the newest
  // reading even when no sort is given, so the results alone can't prove the sort is there.
  // This checks the query itself asks for newest-first, so it never relies on index order.
  test('asks MongoDB for newest-first explicitly instead of relying on index order', async () => {
    const spy = jest.spyOn(GenerationReading, 'findOne');
    await getLastReading('INS-0001');
    expect(spy.mock.results[0].value.getOptions().sort).toEqual({ timestamp: -1 });
    spy.mockRestore();
  });
});

describe('GET /installations/{installation-id} (composite)', () => {
  test('is the installation fields plus one nested last_reading, exactly', async () => {
    const res = await request(app).get('/installations/INS-0001');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ ...installationPart('INS-0001'), last_reading: readingJson('000000000000000000000005') });
  });

  test('newest, not oldest: last_reading is the 12:30Z reading, not the first one', async () => {
    const res = await request(app).get('/installations/INS-0001');
    expect(res.body.last_reading.reading_id).toBe('000000000000000000000005');
    expect(res.body.last_reading.timestamp).toBe('2026-10-06T12:30:00.000Z');
    expect(res.body.last_reading.reading_id).not.toBe('000000000000000000000001'); // the oldest
  });

  describe('a late-arriving older reading', () => {
    afterAll(loadTestSeed);

    test('does not replace the latest: newest is by timestamp, not by insertion order', async () => {
      // Inserted last and given the highest id, but measured two days before the current latest.
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

      const res = await request(app).get('/installations/INS-0001');
      expect(res.body.last_reading.reading_id).toBe('000000000000000000000005');
    });
  });

  test('null case: an installation with no readings has last_reading: null (key present)', async () => {
    const res = await request(app).get('/installations/INS-0005');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('last_reading', null);
    expect(res.body).toEqual({ ...installationPart('INS-0005'), last_reading: null });
  });

  test('an inactive installation shows the last reading it sent before stopping', async () => {
    const res = await request(app).get('/installations/INS-0004');
    expect(res.body.last_reading).toEqual(readingJson('00000000000000000000000b'));
  });

  test('exactly one reading is nested: no history array, no flat last_* fields', async () => {
    const res = await request(app).get('/installations/INS-0001');
    expect(res.body).not.toHaveProperty('readings');
    expect(Object.keys(res.body).filter((k) => k.startsWith('last_'))).toEqual(['last_reading']);
    expect(Array.isArray(res.body.last_reading)).toBe(false);
  });

  test('unknown installation → 404, not 200 with a null reading', async () => {
    expectErrorBody(await request(app).get('/installations/INS-9999'), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('the collection stays plain: list items carry no last_reading', async () => {
    const res = await request(app).get('/installations');
    res.body.forEach((item) => expect(item).not.toHaveProperty('last_reading'));
  });
});
