const request = require('supertest');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const GenerationReading = require('../src/models/generation-reading');
const GridSubstation = require('../src/models/grid-substation');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001 has 5 readings (newest …005); INS-0002 has 3; INS-0005 has none.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const del = (id) => request(app).delete(`/installations/${id}`);
const R5 = '000000000000000000000005';

describe('1. the first DELETE → 200 with what was removed', () => {
  test('200, and the body is the composite exactly as a GET returned it just before', async () => {
    const before = await request(app).get('/installations/INS-0001');
    const res = await del('INS-0001');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(before.body);
    expect(res.body.last_reading.reading_id).toBe(R5);
  });

  test('the installation is gone: GET, the list and the last-known reading no longer find it', async () => {
    await del('INS-0001');
    expectErrorBody(await request(app).get('/installations/INS-0001'), 404, 'INSTALLATION_NOT_FOUND');
    expectErrorBody(await request(app).get('/installations/INS-0001/last-known-reading'), 404, 'INSTALLATION_NOT_FOUND');
    const list = await request(app).get('/installations');
    expect(list.body.results.map((i) => i.installation_id)).not.toContain('INS-0001');
    expect(await SolarInstallation.findById('INS-0001')).toBeNull();
  });

  test('an installation that never reported is removed with last_reading: null', async () => {
    const res = await del('INS-0005');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ installation_id: 'INS-0005', last_reading: null });
  });

  test('no secret hash or change times in the body', async () => {
    const res = await del('INS-0001');
    for (const key of ['device_secret_hash', 'created_at', 'updated_at', '_id', '__v']) expect(res.body).not.toHaveProperty(key);
  });
});

describe('2. the second DELETE → 404', () => {
  test('deleting the same installation again finds nothing', async () => {
    expect((await del('INS-0001')).status).toBe(200);
    const second = await del('INS-0001');
    expectErrorBody(second, 404, 'INSTALLATION_NOT_FOUND');
  });

  test('an id that never existed → 404', async () => {
    expectErrorBody(await del('INS-0999'), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('two DELETEs at the same moment: exactly one 200, one 404', async () => {
    const [a, b] = await Promise.all([del('INS-0002'), del('INS-0002')]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
  });
});

describe('3. its readings remain (no cascade)', () => {
  test('all five readings are still stored, unchanged', async () => {
    const before = await GenerationReading.find({ installation_id: 'INS-0001' }).sort({ timestamp: 1 }).lean();
    await del('INS-0001');
    const after = await GenerationReading.find({ installation_id: 'INS-0001' }).sort({ timestamp: 1 }).lean();
    expect(after).toHaveLength(5);
    expect(after).toEqual(before);
  });

  test('the readings keep their jurisdiction copies, so they still count for their district', async () => {
    await del('INS-0001');
    const reading = await GenerationReading.findById(R5);
    expect([reading.installation_id, reading.substation_id, reading.district_id, reading.province_id]).toEqual(['INS-0001', 'SS-001', 'DT-01', 'PV-01']);
  });

  test('nothing else is touched: other installations, their readings and the substation remain', async () => {
    await del('INS-0001');
    expect(await SolarInstallation.countDocuments()).toBe(4);
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0002' })).toBe(3);
    expect(await GridSubstation.findById('SS-001')).not.toBeNull();
    expect(await GenerationReading.countDocuments()).toBe(11); // every reading in the fixture
  });

  test('the API no longer serves them: the parent is gone, so the scoped readings path is 404', async () => {
    await del('INS-0001');
    expectErrorBody(await request(app).get('/installations/INS-0001/readings'), 404, 'INSTALLATION_NOT_FOUND');
    expectErrorBody(await request(app).get(`/installations/INS-0001/readings/${R5}`), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('a device can no longer add readings to a deleted installation', async () => {
    await del('INS-0001');
    const res = await request(app)
      .post('/installations/INS-0001/readings')
      .send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 });
    expectErrorBody(res, 404, 'INSTALLATION_NOT_FOUND');
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001' })).toBe(5);
  });
});

describe('negotiation', () => {
  test('Accept: text/html → 406, and nothing is deleted', async () => {
    expectErrorBody(await del('INS-0001').set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
    expect(await SolarInstallation.findById('INS-0001')).not.toBeNull();
  });
});
