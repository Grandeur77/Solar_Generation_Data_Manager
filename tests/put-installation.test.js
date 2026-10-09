const request = require('./helpers/authed-request');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const GenerationReading = require('../src/models/generation-reading');
const { strongEtag } = require('../src/utils/http-cache');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase, seed } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001 before: Kolonnawa test rooftop 1, MTR-000001, SS-001 (DT-01 / PV-01), 5 kW, active,
// commissioned 2024-01-15, "No. 1, Test Road, Kolonnawa", 6.9 / 79.9. Newest reading …005.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

// Every writable field different from the stored version, including a Kandy substation.
const REPLACEMENT = {
  name: 'Kandy replacement rooftop',
  meter_id: 'MTR-000901',
  substation_id: 'SS-003',
  capacity_kw: 9.5,
  status: 'inactive',
  commissioned_at: '2025-06-30T00:00:00Z',
  address: 'No. 99, Peradeniya Road, Kandy',
  latitude: 7.29,
  longitude: 80.63,
};
const put = (id, body) => request(app).put(`/installations/${id}`).send(body);
const stored = (id) => SolarInstallation.findById(id);

describe('PUT /installations/{installation-id} — whole-document replacement', () => {
  test('200 with the composite: every field is the new value, with district/province recalculated', async () => {
    const res = await put('INS-0001', REPLACEMENT);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      installation_id: 'INS-0001',
      name: 'Kandy replacement rooftop',
      meter_id: 'MTR-000901',
      substation_id: 'SS-003',
      district_id: 'DT-04',
      province_id: 'PV-02',
      capacity_kw: 9.5,
      status: 'inactive',
      commissioned_at: '2025-06-30T00:00:00.000Z',
      address: 'No. 99, Peradeniya Road, Kandy',
      latitude: 7.29,
      longitude: 80.63,
      last_reading: expect.objectContaining({ reading_id: '000000000000000000000005' }),
    });
  });

  test('new ETag (strong, matches the body) and Last-Modified (the new updated_at)', async () => {
    const before = await request(app).get('/installations/INS-0001');
    const res = await put('INS-0001', REPLACEMENT);
    expect(res.headers.etag).toBe(strongEtag(res.body));
    expect(res.headers.etag).not.toBe(strongEtag(before.body));
    expect(res.headers['last-modified']).toBe((await stored('INS-0001')).updated_at.toUTCString());
  });

  test('a GET afterwards returns exactly what the PUT returned', async () => {
    const res = await put('INS-0001', REPLACEMENT);
    expect((await request(app).get('/installations/INS-0001')).body).toEqual(res.body);
  });

  test('no old value survives anywhere in the stored document', async () => {
    await put('INS-0001', REPLACEMENT);
    const doc = (await stored('INS-0001')).toObject();
    const old = seed.installations.find((i) => i.installation_id === 'INS-0001');
    for (const field of ['name', 'meter_id', 'substation_id', 'district_id', 'province_id', 'capacity_kw', 'status', 'address', 'latitude', 'longitude']) {
      expect(doc[field]).not.toEqual(old[field]);
    }
  });

  test('installation_id equal to the path is allowed in the body', async () => {
    expect((await put('INS-0001', { ...REPLACEMENT, installation_id: 'INS-0001' })).status).toBe(200);
  });

  test('server-managed fields survive: the meter credential still verifies and created_at is unchanged', async () => {
    const before = await stored('INS-0001');
    await put('INS-0001', REPLACEMENT);
    const after = await SolarInstallation.findById('INS-0001').select('+device_secret_hash');
    expect(await bcrypt.compare(seed.deviceSecrets['INS-0001'], after.device_secret_hash)).toBe(true);
    expect(after.created_at.toISOString()).toBe(before.created_at.toISOString());
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });

  test('readings keep the jurisdiction they were recorded under (history is not rewritten)', async () => {
    await put('INS-0001', REPLACEMENT);
    const reading = await GenerationReading.findById('000000000000000000000005');
    expect([reading.substation_id, reading.district_id, reading.province_id]).toEqual(['SS-001', 'DT-01', 'PV-01']);
  });

  test('keeping its own meter_id is fine (not a conflict with itself)', async () => {
    expect((await put('INS-0001', { ...REPLACEMENT, meter_id: 'MTR-000001' })).status).toBe(200);
  });
});

describe('never a merge: a partial body is refused and nothing changes', () => {
  test('a PATCH-style body with one field → 400 listing all eight missing fields', async () => {
    const res = await put('INS-0001', { name: 'Only the name' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field).sort()).toEqual(
      ['address', 'capacity_kw', 'commissioned_at', 'latitude', 'longitude', 'meter_id', 'status', 'substation_id'].sort()
    );
    res.body.details.forEach((d) => expect(d.issue).toBe('Required.'));
    expect((await stored('INS-0001')).name).toBe('Kolonnawa test rooftop 1'); // the one sent field was NOT applied
  });

  test.each(Object.keys(REPLACEMENT))('leaving out only %s → 400, and none of the other new values are applied', async (field) => {
    const { [field]: _left, ...partial } = REPLACEMENT;
    const res = await put('INS-0001', partial);
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([{ field, location: 'body', issue: 'Required.', reference: null }]);

    const doc = await stored('INS-0001');
    expect([doc.name, doc.meter_id, doc.capacity_kw, doc.status]).toEqual(['Kolonnawa test rooftop 1', 'MTR-000001', 5, 'active']);
  });
});

describe('failures', () => {
  test('PUT never creates: an unknown installation → 404, and nothing is created', async () => {
    expectErrorBody(await put('INS-0999', REPLACEMENT), 404, 'INSTALLATION_NOT_FOUND');
    expect(await stored('INS-0999')).toBeNull();
  });

  test('404 is decided before the body: an unknown installation with an invalid body is still 404', async () => {
    expectErrorBody(await put('INS-0999', { name: 'x' }), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('a different installation_id in the body → 400 ID_MISMATCH; nothing changes', async () => {
    const res = await put('INS-0001', { ...REPLACEMENT, installation_id: 'INS-0002' });
    expectErrorBody(res, 400, 'ID_MISMATCH');
    expect(res.body.details[0]).toMatchObject({ field: 'installation_id', location: 'body', reference: '/installations/INS-0001' });
    expect((await stored('INS-0001')).name).toBe('Kolonnawa test rooftop 1');
    expect((await stored('INS-0002')).name).toBe('Kolonnawa test rooftop 2');
  });

  test.each(['district_id', 'province_id', 'last_reading'])('server-set %s in the body → 400', async (field) => {
    const res = await put('INS-0001', { ...REPLACEMENT, [field]: field === 'last_reading' ? null : 'DT-01' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field)).toEqual([field]);
  });

  test('unknown substation → 400 UNKNOWN_SUBSTATION; nothing changes', async () => {
    expectErrorBody(await put('INS-0001', { ...REPLACEMENT, substation_id: 'SS-999' }), 400, 'UNKNOWN_SUBSTATION');
    expect((await stored('INS-0001')).substation_id).toBe('SS-001');
  });

  test('meter_id used by another installation → 409 METER_ID_TAKEN; nothing changes', async () => {
    expectErrorBody(await put('INS-0001', { ...REPLACEMENT, meter_id: 'MTR-000002' }), 409, 'METER_ID_TAKEN');
    expect((await stored('INS-0001')).meter_id).toBe('MTR-000001');
  });

  test('non-JSON body → 415', async () => {
    const res = await request(app).put('/installations/INS-0001').set('Content-Type', 'text/plain').send('x');
    expectErrorBody(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('PATCH is not offered → 405 with Allow: GET, HEAD, PUT, DELETE', async () => {
    const res = await request(app).patch('/installations/INS-0001').send({ name: 'x' });
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('GET, HEAD, PUT, DELETE');
    expect((await stored('INS-0001')).name).toBe('Kolonnawa test rooftop 1');
  });
});
