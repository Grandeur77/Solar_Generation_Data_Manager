const request = require('supertest');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const GenerationReading = require('../src/models/generation-reading');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const { signToken } = require('../src/utils/tokens');

// Step 9.5: scope checks. Every token here comes from POST /auth/tokens, exactly as a real client
// gets it, so the whole chain (sign-in → token → route check) is exercised.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

async function tokenFor(credentials) {
  const res = await request(app).post('/auth/tokens').send(credentials);
  expect(res.status).toBe(201);
  return res.body.access_token;
}
const device = (n) => tokenFor({ meter_id: `MTR-00000${n}`, device_secret: `test-device-secret-INS-000${n}` });
const analyst = () => tokenFor({ email: 'colombo@test.example', password: 'test-colombo-pass' });
const nationalAnalyst = () => tokenFor({ email: 'national@test.example', password: 'test-national-pass' });
const admin = () => tokenFor({ email: 'admin@test.example', password: 'test-admin-pass' });

const as = (token) => ({
  get: (path) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  head: (path) => request(app).head(path).set('Authorization', `Bearer ${token}`),
  post: (path, body) => request(app).post(path).set('Authorization', `Bearer ${token}`).send(body),
  put: (path, body) => request(app).put(path).set('Authorization', `Bearer ${token}`).send(body),
  delete: (path) => request(app).delete(path).set('Authorization', `Bearer ${token}`),
});

const READING = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.4, energy_kwh: 1021, voltage: 230 };
const INSTALLATION = {
  installation_id: 'INS-0006', name: 'Kolonnawa test rooftop 6', meter_id: 'MTR-000006', substation_id: 'SS-001',
  capacity_kw: 5, status: 'active', commissioned_at: '2026-10-01T00:00:00Z', address: 'No. 6, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
};
const REPLACEMENT = { ...INSTALLATION, installation_id: undefined, meter_id: 'MTR-000001', name: 'Renamed' };

function expectScope403(res, scope) {
  expect(res.status).toBe(403);
  if (res.request.method !== 'HEAD') {
    expectErrorBody(res, 403, 'INSUFFICIENT_SCOPE');
    expect(res.body.details).toEqual([{ field: 'Authorization', location: 'header', issue: `Requires the ${scope} scope.`, reference: null }]);
  }
  expect(res.headers['www-authenticate']).toBe(`Bearer realm="slsea-solar-api", error="insufficient_scope", scope="${scope}"`);
  expect(res.headers['cache-control']).toBe('no-store');
}

const READ_ROUTES = [
  '/provinces', '/provinces/PV-01', '/provinces/PV-01/generation-summary',
  '/districts', '/districts/DT-01', '/districts/DT-01/generation-summary',
  '/grid-substations', '/grid-substations/SS-001',
  '/installations', '/installations/INS-0001', '/installations/INS-0001/last-known-reading',
  '/installations/INS-0001/readings', '/installations/INS-0001/readings/000000000000000000000005',
];

describe('1. a device writing to another installation → 403 INSTALLATION_MISMATCH', () => {
  test('INS-0001\'s token posting to INS-0002 → 403, and nothing is stored', async () => {
    const before = await GenerationReading.countDocuments({ installation_id: 'INS-0002' });
    const res = await as(await device(1)).post('/installations/INS-0002/readings', { ...READING, energy_kwh: 511 });
    expectErrorBody(res, 403, 'INSTALLATION_MISMATCH');
    expect(res.body.details).toEqual([
      { field: 'installation-id', location: 'path', issue: 'Must be INS-0001, the installation this token belongs to.', reference: '/installations/INS-0001' },
    ]);
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0002' })).toBe(before);
  });

  test('to an installation that does not exist → 403, not 404 (a meter learns nothing about other ids)', async () => {
    expectErrorBody(await as(await device(1)).post('/installations/INS-9999/readings', READING), 403, 'INSTALLATION_MISMATCH');
  });

  test('checked before the body: an invalid body to another installation is still 403, not 400 or 415', async () => {
    const token = await device(1);
    expectErrorBody(await as(token).post('/installations/INS-0002/readings', { power_kw: 'lots' }), 403, 'INSTALLATION_MISMATCH');
    const text = await request(app).post('/installations/INS-0002/readings').set('Authorization', `Bearer ${token}`).type('text').send('x');
    expectErrorBody(text, 403, 'INSTALLATION_MISMATCH');
  });

  test('its own installation → 201', async () => {
    const res = await as(await device(1)).post('/installations/INS-0001/readings', READING);
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/^\/installations\/INS-0001\/readings\/[0-9a-f]{24}$/);
  });
});

describe('2. a device calling any read route → 403 INSUFFICIENT_SCOPE', () => {
  test.each(READ_ROUTES)('GET %s', async (path) => {
    expectScope403(await as(await device(1)).get(path), 'analyst-read-by-jurisdiction');
  });

  test('HEAD is a read too', async () => {
    expectScope403(await as(await device(1)).head('/installations/INS-0001'), 'analyst-read-by-jurisdiction');
  });

  test('not even its own installation or its own readings', async () => {
    const token = await device(1);
    expectScope403(await as(token).get('/installations/INS-0001/readings'), 'analyst-read-by-jurisdiction');
    expectScope403(await as(token).get('/installations/INS-0001/last-known-reading'), 'analyst-read-by-jurisdiction');
  });

  test('a device cannot use the registry either', async () => {
    const token = await device(1);
    expectScope403(await as(token).post('/installations', INSTALLATION), 'asset-admin');
    expectScope403(await as(token).put('/installations/INS-0001', REPLACEMENT), 'asset-admin');
    expectScope403(await as(token).delete('/installations/INS-0001'), 'asset-admin');
  });

  test('403 comes before 404: a missing installation looks the same as an existing one', async () => {
    const token = await device(1);
    const missing = await as(token).get('/installations/INS-9999');
    expectScope403(missing, 'analyst-read-by-jurisdiction');
    expect(missing.body).toEqual((await as(token).get('/installations/INS-0001')).body);
  });
});

describe('3. a read user attempting any write → 403 INSUFFICIENT_SCOPE', () => {
  test.each([['district analyst', analyst], ['national analyst', nationalAnalyst]])('%s: posting a reading → 403 (needs installation-write)', async (_, who) => {
    const before = await GenerationReading.countDocuments();
    expectScope403(await as(await who()).post('/installations/INS-0001/readings', READING), 'installation-write');
    expect(await GenerationReading.countDocuments()).toBe(before);
  });

  test.each([['district analyst', analyst], ['national analyst', nationalAnalyst]])('%s: registering, replacing or deleting an installation → 403 (needs asset-admin)', async (_, who) => {
    const token = await who();
    expectScope403(await as(token).post('/installations', INSTALLATION), 'asset-admin');
    expectScope403(await as(token).put('/installations/INS-0001', REPLACEMENT), 'asset-admin');
    expectScope403(await as(token).delete('/installations/INS-0001'), 'asset-admin');
    expect(await SolarInstallation.findById('INS-0006')).toBeNull();
    expect((await SolarInstallation.findById('INS-0001')).name).toBe('Kolonnawa test rooftop 1');
  });

  test('the registry admin never writes readings either (its scopes have no installation-write)', async () => {
    expectScope403(await as(await admin()).post('/installations/INS-0001/readings', READING), 'installation-write');
  });

  test('checked before 404, 412, 415 and 400', async () => {
    const token = await analyst();
    expectScope403(await as(token).put('/installations/INS-9999', REPLACEMENT), 'asset-admin');
    expectScope403(await as(token).put('/installations/INS-0001', { name: 'only' }), 'asset-admin');
    expectScope403(await request(app).put('/installations/INS-0001').set('Authorization', `Bearer ${token}`).set('If-Match', '"stale"').send(REPLACEMENT), 'asset-admin');
    expectScope403(await request(app).post('/installations').set('Authorization', `Bearer ${token}`).type('text').send('x'), 'asset-admin');
  });

  test('an analyst can still read', async () => {
    expect((await as(await analyst()).get('/installations/INS-0001')).status).toBe(200);
  });
});

describe('4. a non-admin calling registry routes → 403; the admin is allowed', () => {
  test('the admin registers, replaces and deletes', async () => {
    const token = await admin();
    expect((await as(token).post('/installations', INSTALLATION)).status).toBe(201);
    expect((await as(token).put('/installations/INS-0001', REPLACEMENT)).status).toBe(200);
    expect((await as(token).delete('/installations/INS-0006')).status).toBe(200);
  });

  test('the admin can also read (both scopes)', async () => {
    expect((await as(await admin()).get('/provinces')).status).toBe(200);
  });

  test.each([['device', () => device(1)], ['district analyst', analyst], ['national analyst', nationalAnalyst]])('%s → 403 on every registry write', async (_, who) => {
    const token = await who();
    for (const res of [
      await as(token).post('/installations', INSTALLATION),
      await as(token).put('/installations/INS-0001', REPLACEMENT),
      await as(token).delete('/installations/INS-0001'),
    ]) {
      expectScope403(res, 'asset-admin');
    }
    expect(await SolarInstallation.countDocuments()).toBe(5);
  });
});

describe('scopes are matched exactly, never as part of a longer name', () => {
  // Validly signed tokens whose scope only looks like a real one.
  const lookalike = (scope) => signToken({ subject: 'USR-007', claims: { scope, jurisdiction: { level: 'national', id: null } }, lifetimeSeconds: 60 });

  test.each([
    ['not-asset-admin', 'post', '/installations', 'asset-admin'],
    ['asset-admin-readonly', 'delete', '/installations/INS-0001', 'asset-admin'],
    ['analyst-read-by-jurisdiction-lite', 'get', '/provinces', 'analyst-read-by-jurisdiction'],
    ['xinstallation-write', 'post', '/installations/USR-007/readings', 'installation-write'],
  ])('scope "%s" does not grant %s %s', async (scope, method, path, needed) => {
    const res = await request(app)[method](path).set('Authorization', `Bearer ${lookalike(scope)}`).send(method === 'post' ? {} : undefined);
    expectScope403(res, needed);
  });
});

describe('the order around the scope checks', () => {
  test('405 still comes before 403: a method a URI never allows is 405 for anyone authenticated', async () => {
    const token = await device(1);
    const res = await request(app).patch('/installations/INS-0001').set('Authorization', `Bearer ${token}`).send({});
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    const summary = await request(app).post('/districts/DT-01/generation-summary').set('Authorization', `Bearer ${await analyst()}`);
    expectErrorBody(summary, 405, 'METHOD_NOT_ALLOWED');
  });

  test('405 before 403 on a read path too: a meter posting to a summary gets 405, not 403', async () => {
    const res = await request(app).post('/districts/DT-01/generation-summary').set('Authorization', `Bearer ${await device(1)}`);
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  test('401 still comes before 403: no token is 401 even on a route the caller could never use', async () => {
    expectErrorBody(await request(app).post('/installations').send(INSTALLATION), 401, 'AUTHENTICATION_REQUIRED');
  });

  test('a 403 has no ETag and is never cached', async () => {
    const res = await as(await device(1)).get('/provinces');
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
