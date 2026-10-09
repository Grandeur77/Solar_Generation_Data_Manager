const request = require('supertest');
const app = require('../src/app');
const GenerationReading = require('../src/models/generation-reading');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const { adminToken, deviceToken } = require('./helpers/authed-request');

// Regressions for the Step 9.9 review findings.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

// F1: the query-string guard ran before authentication, so an anonymous caller got 400, not 401.
describe('F1: authentication comes before the query-string guard', () => {
  test.each(['/provinces?a.b=1', '/installations/INS-9999?x$=1', '/installations?status[$ne]=active'])('no token: GET %s → 401, not 400', async (path) => {
    const res = await request(app).get(path);
    expectErrorBody(res, 401, 'AUTHENTICATION_REQUIRED');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="slsea-solar-api"');
  });

  test('with a valid token the guard still refuses the key (400)', async () => {
    const res = await request(app).get('/provinces?a.b=1').set('Authorization', `Bearer ${adminToken()}`);
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details[0]).toMatchObject({ field: 'a.b', location: 'query' });
  });

  test('public routes are still guarded: POST /auth/tokens?$where=1 → 400', async () => {
    const res = await request(app).post('/auth/tokens?$where=1').send({ email: 'national@test.example', password: 'test-national-pass' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
  });
});

// F2: a meter token issued before its installation was deactivated could still add readings for
// up to 24 h. The installation's status is now checked on every reading.
describe('F2: an inactive installation cannot add readings, whatever token its meter holds', () => {
  const READING = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1021, voltage: 230 };
  const FULL = {
    name: 'Kolonnawa test rooftop 1', meter_id: 'MTR-000001', substation_id: 'SS-001', capacity_kw: 5,
    commissioned_at: '2024-01-15T00:00:00Z', address: 'No. 1, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
  };
  const setStatus = (status) => request(app).put('/installations/INS-0001').set('Authorization', `Bearer ${adminToken()}`).send({ ...FULL, status });
  const post = (token, body = READING) => request(app).post('/installations/INS-0001/readings').set('Authorization', `Bearer ${token}`).send(body);

  test('a token from before the deactivation → 403 ACCOUNT_INACTIVE, and nothing is stored', async () => {
    const signIn = await request(app).post('/auth/tokens').send({ meter_id: 'MTR-000001', device_secret: 'test-device-secret-INS-0001' });
    expect(signIn.status).toBe(201);
    expect((await setStatus('inactive')).status).toBe(200);

    const before = await GenerationReading.countDocuments({ installation_id: 'INS-0001' });
    const res = await post(signIn.body.access_token);
    expectErrorBody(res, 403, 'ACCOUNT_INACTIVE');
    expect(res.body.message).toBe('Installation INS-0001 is inactive and cannot add readings.');
    expect(await GenerationReading.countDocuments({ installation_id: 'INS-0001' })).toBe(before);
  });

  test('reactivated → the same token works again (201)', async () => {
    const token = deviceToken('INS-0001');
    await setStatus('inactive');
    expect((await post(token)).status).toBe(403);
    await setStatus('active');
    expect((await post(token)).status).toBe(201);
  });

  test('the seed\'s inactive INS-0004 refuses readings too', async () => {
    const res = await request(app).post('/installations/INS-0004/readings').set('Authorization', `Bearer ${deviceToken('INS-0004')}`)
      .send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 1, energy_kwh: 2001, voltage: 230 });
    expectErrorBody(res, 403, 'ACCOUNT_INACTIVE');
  });

  test('the order: 403 inactive comes before 400 (invalid body) and 415 (not JSON)', async () => {
    await setStatus('inactive');
    const token = deviceToken('INS-0001');
    expectErrorBody(await post(token, { power_kw: 'lots' }), 403, 'ACCOUNT_INACTIVE');
    const text = await request(app).post('/installations/INS-0001/readings').set('Authorization', `Bearer ${token}`).type('text').send('x');
    expectErrorBody(text, 403, 'ACCOUNT_INACTIVE');
  });

  test('a deleted installation is 404 before its body is read (even a text body)', async () => {
    await request(app).delete('/installations/INS-0005').set('Authorization', `Bearer ${adminToken()}`);
    const res = await request(app).post('/installations/INS-0005/readings').set('Authorization', `Bearer ${deviceToken('INS-0005')}`).type('text').send('x');
    expectErrorBody(res, 404, 'INSTALLATION_NOT_FOUND');
  });

  test('an active installation is unaffected (201)', async () => {
    expect((await post(deviceToken('INS-0001'))).status).toBe(201);
  });
});
