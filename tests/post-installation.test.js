const request = require('./helpers/authed-request');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const { strongEtag } = require('../src/utils/http-cache');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture: SS-002 is in DT-02 (Gampaha), which is in PV-01 (Western). INS-0001 uses MTR-000001.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const NEW = {
  installation_id: 'INS-0006',
  name: 'Gampaha test rooftop 6',
  meter_id: 'MTR-000006',
  substation_id: 'SS-002',
  capacity_kw: 4.2,
  status: 'active',
  commissioned_at: '2026-10-01T00:00:00Z',
  address: 'No. 6, Test Road, Gampaha',
  latitude: 7.09,
  longitude: 80.0,
};
const post = (body) => request(app).post('/installations').send(body);
const stored = (id) => SolarInstallation.findById(id);

describe('POST /installations — success', () => {
  test('201 with the composite, Location, a strong ETag and Last-Modified', async () => {
    const res = await post(NEW);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      installation_id: 'INS-0006',
      name: 'Gampaha test rooftop 6',
      meter_id: 'MTR-000006',
      substation_id: 'SS-002',
      district_id: 'DT-02',
      province_id: 'PV-01',
      capacity_kw: 4.2,
      status: 'active',
      commissioned_at: '2026-10-01T00:00:00.000Z',
      address: 'No. 6, Test Road, Gampaha',
      latitude: 7.09,
      longitude: 80.0,
      last_reading: null,
    });
    expect(res.headers.location).toBe('/installations/INS-0006');
    expect(res.headers.etag).toBe(strongEtag(res.body));
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
    const doc = await stored('INS-0006');
    expect(res.headers['last-modified']).toBe(doc.updated_at.toUTCString());
  });

  test('GET on the Location returns 200 with the same body', async () => {
    const created = await post(NEW);
    const res = await request(app).get(created.headers.location);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test('the new installation appears in the filtered collection by its derived district', async () => {
    await post(NEW);
    const res = await request(app).get('/installations?district-id=DT-02');
    expect(res.body.results.map((i) => i.installation_id)).toEqual(['INS-0003', 'INS-0006']);
  });

  test('district_id and province_id are derived from the substation (a Kandy substation gives DT-04 / PV-02)', async () => {
    const res = await post({ ...NEW, substation_id: 'SS-003' });
    expect([res.body.district_id, res.body.province_id]).toEqual(['DT-04', 'PV-02']);
  });

  test('no secret hash and no change times in the response', async () => {
    const res = await post(NEW);
    for (const key of ['device_secret_hash', 'created_at', 'updated_at', '_id', '__v']) expect(res.body).not.toHaveProperty(key);
  });
});

describe('server-set fields are never trusted from the body', () => {
  test.each([
    ['district_id', 'DT-04'],
    ['province_id', 'PV-02'],
    ['last_reading', null],
  ])('%s in the body → 400, and nothing is stored', async (field, value) => {
    const res = await post({ ...NEW, [field]: value });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([{ field, location: 'body', issue: expect.any(String), reference: null }]);
    expect(await stored('INS-0006')).toBeNull();
  });

  test('even a correct district_id is refused (it is the server\'s job, not the client\'s)', async () => {
    expectErrorBody(await post({ ...NEW, district_id: 'DT-02' }), 400, 'VALIDATION_FAILED');
  });
});

describe('unknown substation → 400 UNKNOWN_SUBSTATION (not 404)', () => {
  test('a well-formed but unknown substation_id', async () => {
    const res = await post({ ...NEW, substation_id: 'SS-999' });
    expectErrorBody(res, 400, 'UNKNOWN_SUBSTATION');
    expect(res.body.details).toEqual([{ field: 'substation_id', location: 'body', issue: expect.any(String), reference: null }]);
    expect(await stored('INS-0006')).toBeNull();
  });
});

describe('409 when an identifier is taken', () => {
  test('installation_id already registered → INSTALLATION_ID_TAKEN referencing it; the existing one is unchanged', async () => {
    const res = await post({ ...NEW, installation_id: 'INS-0001' });
    expectErrorBody(res, 409, 'INSTALLATION_ID_TAKEN');
    expect(res.body.details).toEqual([{ field: 'installation_id', location: 'body', issue: 'Already registered.', reference: '/installations/INS-0001' }]);
    expect((await stored('INS-0001')).name).toBe('Kolonnawa test rooftop 1');
  });

  test('meter_id already fitted elsewhere → METER_ID_TAKEN; nothing stored', async () => {
    const res = await post({ ...NEW, meter_id: 'MTR-000001' });
    expectErrorBody(res, 409, 'METER_ID_TAKEN');
    expect(res.body.details[0]).toMatchObject({ field: 'meter_id', location: 'body' });
    expect(await stored('INS-0006')).toBeNull();
  });

  test('two identical registrations at the same moment: exactly one is created', async () => {
    const [a, b] = await Promise.all([post(NEW), post(NEW)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await SolarInstallation.countDocuments({ _id: 'INS-0006' })).toBe(1);
  });
});

describe('body validation → 400 VALIDATION_FAILED', () => {
  test('an empty body reports all ten required fields', async () => {
    const res = await post({});
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field).sort()).toEqual(
      ['address', 'capacity_kw', 'commissioned_at', 'installation_id', 'latitude', 'longitude', 'meter_id', 'name', 'status', 'substation_id'].sort()
    );
  });

  test.each([
    ['installation_id', 'INS-6'],
    ['meter_id', 'METER-1'],
    ['substation_id', 'SS-02'],
    ['capacity_kw', 0],
    ['capacity_kw', -4],
    ['capacity_kw', '4.2'],
    ['status', 'retired'],
    ['commissioned_at', '2026-10-01'],
    ['commissioned_at', '2026-10-01T00:00:00'],
    ['latitude', 91],
    ['longitude', -181],
    ['name', '   '],
    ['address', 42],
  ])('%s = %j → 400 naming that field', async (field, value) => {
    const res = await post({ ...NEW, [field]: value });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field)).toEqual([field]);
  });

  test('an unknown field → 400', async () => {
    const res = await post({ ...NEW, colour: 'blue' });
    expect(res.body.details.map((d) => d.field)).toEqual(['colour']);
  });

  test('a malformed substation_id is VALIDATION_FAILED, not UNKNOWN_SUBSTATION', async () => {
    expectErrorBody(await post({ ...NEW, substation_id: 'kolonnawa' }), 400, 'VALIDATION_FAILED');
  });
});

describe('content type and negotiation', () => {
  test('non-JSON body → 415', async () => {
    const res = await request(app).post('/installations').set('Content-Type', 'text/plain').send('INS-0006');
    expectErrorBody(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('malformed JSON → 400 INVALID_JSON', async () => {
    const res = await request(app).post('/installations').set('Content-Type', 'application/json').send('{"name":');
    expectErrorBody(res, 400, 'INVALID_JSON');
  });

  test('Accept: text/html → 406', async () => {
    expectErrorBody(await post(NEW).set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
  });
});
