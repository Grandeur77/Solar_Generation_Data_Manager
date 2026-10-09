const request = require('./helpers/authed-request');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { strongEtag } = require('../src/utils/http-cache');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// INS-0001 is in SS-001 / DT-01 / PV-01; its newest fixture reading is 2026-10-06T12:30Z.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed); // each test starts from the fixture, so created readings never leak
afterAll(tearDownTestDatabase);

const VALID = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 };
const post = (id, body) => request(app).post(`/installations/${id}/readings`).send(body);

describe('POST /installations/{installation-id}/readings — success', () => {
  test('201 with Location, a strong ETag, Last-Modified and the stored reading', async () => {
    const before = Date.now();
    const res = await post('INS-0001', VALID);
    const after = Date.now();

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      reading_id: expect.stringMatching(/^[0-9a-f]{24}$/),
      installation_id: 'INS-0001',
      timestamp: '2026-10-06T12:45:00.000Z',
      power_kw: 0.3,
      energy_kwh: 1020.1,
      voltage: 230.1,
      received_at: expect.any(String),
    });

    // received_at is the server's clock at the moment of storing.
    const received = Date.parse(res.body.received_at);
    expect(received).toBeGreaterThanOrEqual(before);
    expect(received).toBeLessThanOrEqual(after);

    expect(res.headers.location).toBe(`/installations/INS-0001/readings/${res.body.reading_id}`);
    expect(res.headers.etag).toBe(strongEtag(res.body));
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/); // strong (no W/ prefix), quoted
    expect(res.headers['last-modified']).toBe(new Date(res.body.received_at).toUTCString());
  });

  test('GET on the Location returns 200 with the same reading', async () => {
    const created = await post('INS-0001', VALID);
    const res = await request(app).get(created.headers.location);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  test('the stored reading copies its jurisdiction ids from the installation, not from the client', async () => {
    const created = await post('INS-0001', VALID);
    const stored = await GenerationReading.findById(created.body.reading_id);
    expect([stored.substation_id, stored.district_id, stored.province_id]).toEqual(['SS-001', 'DT-01', 'PV-01']);
    expect(created.body).not.toHaveProperty('district_id'); // stored, but not part of the representation
  });

  test('a newer reading becomes the last-known reading', async () => {
    const created = await post('INS-0001', VALID);
    const res = await request(app).get('/installations/INS-0001/last-known-reading');
    expect(res.body.reading_id).toBe(created.body.reading_id);
  });

  test('the first reading of an installation with no history works', async () => {
    const res = await post('INS-0005', VALID);
    expect(res.status).toBe(201);
    expect(res.body.installation_id).toBe('INS-0005');
  });
});

describe('installation_id comes from the path, never the body', () => {
  test('installation_id in the body → 400, and nothing is stored', async () => {
    const res = await post('INS-0001', { ...VALID, installation_id: 'INS-0001' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([
      { field: 'installation_id', location: 'body', issue: expect.stringContaining('path'), reference: null },
    ]);
    expect(await GenerationReading.countDocuments({ timestamp: new Date(VALID.timestamp) })).toBe(0);
  });

  test('a different installation_id in the body can\'t redirect the reading to another installation', async () => {
    const res = await post('INS-0001', { ...VALID, installation_id: 'INS-0002' });
    expect(res.status).toBe(400);
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0002', timestamp: new Date(VALID.timestamp) })).toBe(0);
  });

  test.each(['received_at', 'reading_id', 'district_id'])('server-set field %s in the body → 400', async (field) => {
    const res = await post('INS-0001', { ...VALID, [field]: field === 'received_at' ? '2020-01-01T00:00:00Z' : 'x' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field)).toEqual([field]);
  });
});

describe('body validation → 400 VALIDATION_FAILED', () => {
  test('every missing field is reported, one details entry each', async () => {
    const res = await post('INS-0001', {});
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['energy_kwh', 'power_kw', 'timestamp', 'voltage']);
    res.body.details.forEach((d) => expect(d).toMatchObject({ location: 'body', reference: null }));
  });

  test.each([
    ['power_kw as a string', { power_kw: '3.5' }, 'power_kw'],
    ['negative power_kw', { power_kw: -1 }, 'power_kw'],
    ['negative energy_kwh', { energy_kwh: -0.1 }, 'energy_kwh'],
    ['voltage as text', { voltage: 'high' }, 'voltage'],
    ['timestamp that is not a date', { timestamp: 'yesterday' }, 'timestamp'],
    ['timestamp without a time zone', { timestamp: '2026-10-06T12:45:00' }, 'timestamp'],
    ['timestamp as a number', { timestamp: 1791290700000 }, 'timestamp'],
  ])('%s', async (label, change, field) => {
    const res = await post('INS-0001', { ...VALID, ...change });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field)).toEqual([field]);
  });

  test.each([
    ['an array', [VALID]],
    ['a number', 42],
    ['null', null],
  ])('a body that is %s → 400', async (label, body) => {
    const res = await request(app)
      .post('/installations/INS-0001/readings')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
  });
});

describe('content type and parsing', () => {
  test.each([
    ['text/plain', 'timestamp=2026'],
    ['application/x-www-form-urlencoded', 'power_kw=3'],
  ])('Content-Type %s → 415 UNSUPPORTED_MEDIA_TYPE', async (type, body) => {
    const res = await request(app).post('/installations/INS-0001/readings').set('Content-Type', type).send(body);
    expectErrorBody(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('no body and no Content-Type → 415', async () => {
    expectErrorBody(await request(app).post('/installations/INS-0001/readings'), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('malformed JSON → 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/installations/INS-0001/readings')
      .set('Content-Type', 'application/json')
      .send('{"power_kw": 3,');
    expectErrorBody(res, 400, 'INVALID_JSON');
  });

  test('a body over 100 KB → 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await post('INS-0001', { ...VALID, padding: 'x'.repeat(110 * 1024) });
    expectErrorBody(res, 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('other failures', () => {
  test('unknown installation → 404 INSTALLATION_NOT_FOUND, and nothing is stored', async () => {
    const res = await post('INS-9999', VALID);
    expectErrorBody(res, 404, 'INSTALLATION_NOT_FOUND');
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-9999' })).toBe(0);
  });

  test('Accept: text/html → 406', async () => {
    const res = await post('INS-0001', VALID).set('Accept', 'text/html');
    expectErrorBody(res, 406, 'NOT_ACCEPTABLE');
  });
});
