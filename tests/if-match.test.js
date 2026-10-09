const request = require('./helpers/authed-request');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

// A complete replacement for INS-0001 (5 kW, Kolonnawa).
const FULL = {
  name: 'Kolonnawa rooftop 1 (renamed)',
  meter_id: 'MTR-000001',
  substation_id: 'SS-001',
  capacity_kw: 5,
  status: 'active',
  commissioned_at: '2024-01-15T00:00:00Z',
  address: 'No. 1, Test Road, Kolonnawa',
  latitude: 6.9,
  longitude: 79.9,
};
const etagOf = async (id) => (await request(app).get(`/installations/${id}`)).headers.etag;
const put = (id, body, ifMatch) => {
  const req = request(app).put(`/installations/${id}`);
  if (ifMatch !== undefined) req.set('If-Match', ifMatch);
  return req.send(body);
};
const del = (id, ifMatch) => {
  const req = request(app).delete(`/installations/${id}`);
  if (ifMatch !== undefined) req.set('If-Match', ifMatch);
  return req;
};

function expect412(res) {
  expect(res.status).toBe(412);
  expectErrorBody(res, 412, 'PRECONDITION_FAILED');
  expect(res.body.details).toEqual([{ field: 'If-Match', location: 'header', issue: expect.any(String), reference: null }]);
  expect(res.headers.etag).toBeUndefined();
  expect(res.headers['cache-control']).toBe('no-store');
}

describe('PUT with If-Match', () => {
  test('the current ETag → 200, and the response carries the next ETag', async () => {
    const etag = await etagOf('INS-0001');
    const res = await put('INS-0001', FULL, etag);
    expect(res.status).toBe(200);
    expect(res.headers.etag).not.toBe(etag);
    expect(res.headers.etag).toBe(await etagOf('INS-0001'));
  });

  test('a stale ETag → 412, and nothing changes', async () => {
    const stale = await etagOf('INS-0001');
    expect((await put('INS-0001', FULL, stale)).status).toBe(200); // the installation changes
    const res = await put('INS-0001', { ...FULL, name: 'Second edit' }, stale);
    expect412(res);
    expect((await SolarInstallation.findById('INS-0001')).name).toBe('Kolonnawa rooftop 1 (renamed)');
  });

  test('a lost update is prevented: admin B, working from the old version, gets 412', async () => {
    const seenByA = await etagOf('INS-0001');
    const seenByB = await etagOf('INS-0001');
    expect((await put('INS-0001', { ...FULL, name: 'A\'s edit' }, seenByA)).status).toBe(200);
    expect412(await put('INS-0001', { ...FULL, name: 'B\'s edit' }, seenByB));
    expect((await SolarInstallation.findById('INS-0001')).name).toBe('A\'s edit');
  });

  test('an ETag that was never valid → 412', async () => {
    expect412(await put('INS-0001', FULL, '"0000000000000000000000000000000000000000"'));
  });

  test('the weak form W/"…" of the current ETag → 412 (If-Match uses strong comparison)', async () => {
    expect412(await put('INS-0001', FULL, `W/${await etagOf('INS-0001')}`));
  });

  test('a list that contains the current ETag → 200', async () => {
    expect((await put('INS-0001', FULL, `"aaaa", ${await etagOf('INS-0001')}`)).status).toBe(200);
  });

  test('"*" → 200 for an existing installation', async () => {
    expect((await put('INS-0001', FULL, '*')).status).toBe(200);
  });

  test('no If-Match → 200 (it is optional)', async () => {
    expect((await put('INS-0001', FULL)).status).toBe(200);
  });

  test('the ETag from a 201 POST works as If-Match for the next PUT', async () => {
    const created = await request(app)
      .post('/installations')
      .send({ ...FULL, installation_id: 'INS-0006', meter_id: 'MTR-000006' });
    expect(created.status).toBe(201);
    expect((await put('INS-0006', { ...FULL, meter_id: 'MTR-000006', name: 'Edited' }, created.headers.etag)).status).toBe(200);
  });

  test('a new reading changes the composite, so an ETag from before it → 412 (errs on the safe side)', async () => {
    const before = await etagOf('INS-0001');
    await request(app)
      .post('/installations/INS-0001/readings')
      .send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 });
    expect412(await put('INS-0001', FULL, before));
  });
});

describe('the order of checks', () => {
  test('a missing installation is 404 before If-Match is looked at (even with "*")', async () => {
    expectErrorBody(await put('INS-0999', FULL, '*'), 404, 'INSTALLATION_NOT_FOUND');
    expectErrorBody(await put('INS-0999', FULL, '"stale"'), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('412 comes before body validation: a stale ETag with an invalid body is 412, not 400', async () => {
    expect412(await put('INS-0001', { name: 'only a name' }, '"stale"'));
  });

  test('412 comes before the content type check: a stale ETag with a text body is 412, not 415', async () => {
    const res = await request(app).put('/installations/INS-0001').set('If-Match', '"stale"').set('Content-Type', 'text/plain').send('x');
    expect412(res);
  });

  test('with the current ETag, the body is still validated (400)', async () => {
    expectErrorBody(await put('INS-0001', { name: 'only a name' }, await etagOf('INS-0001')), 400, 'VALIDATION_FAILED');
  });
});

describe('DELETE with If-Match', () => {
  test('a stale ETag → 412, and the installation still exists', async () => {
    const stale = await etagOf('INS-0001');
    await put('INS-0001', FULL);
    expect412(await del('INS-0001', stale));
    expect(await SolarInstallation.findById('INS-0001')).not.toBeNull();
  });

  test('the current ETag → 200; then 404', async () => {
    const etag = await etagOf('INS-0002');
    expect((await del('INS-0002', etag)).status).toBe(200);
    expectErrorBody(await del('INS-0002', etag), 404, 'INSTALLATION_NOT_FOUND');
  });

  test('"*" → 200; no If-Match → 200', async () => {
    expect((await del('INS-0003', '*')).status).toBe(200);
    expect((await del('INS-0005')).status).toBe(200);
  });

  test('the weak form of the current ETag → 412', async () => {
    expect412(await del('INS-0001', `W/${await etagOf('INS-0001')}`));
  });
});
