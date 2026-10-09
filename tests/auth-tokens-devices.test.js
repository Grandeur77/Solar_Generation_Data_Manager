const request = require('supertest');
// Registry calls used to set up a case need a token; sign-in itself is public.
const asAdmin = require('./helpers/authed-request');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Test meters (tests/fixtures/test-seed.js): INS-000n has meter MTR-00000n and the test-only secret
// "test-device-secret-INS-000n". INS-0004 (MTR-000004) is inactive.
beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const secretOf = (installationId) => `test-device-secret-${installationId}`;
const meterSignIn = (meter_id, device_secret) => request(app).post('/auth/tokens').send({ meter_id, device_secret });
const verify = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'slsea-solar-api/auth', audience: 'slsea-solar-api' });

describe('201: an installation-write token bound to the meter\'s installation', () => {
  test('MTR-000001 → installation-write for 24 h, sub INS-0001, no jurisdiction', async () => {
    const res = await meterSignIn('MTR-000001', secretOf('INS-0001'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ access_token: expect.any(String), token_type: 'Bearer', expires_in: 86400, scope: 'installation-write' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBeUndefined();
    expect(res.headers.etag).toBeUndefined();

    const claims = verify(res.body.access_token);
    // Exactly these claims: no jurisdiction (a meter reads nothing), no meter id or secret.
    expect(claims).toEqual({
      sub: 'INS-0001',
      scope: 'installation-write',
      iss: 'slsea-solar-api/auth',
      aud: 'slsea-solar-api',
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(claims.exp - claims.iat).toBe(86400);
  });

  test.each(['INS-0001', 'INS-0002', 'INS-0003', 'INS-0005'])('each active meter is bound to its own installation: %s', async (installationId) => {
    const res = await meterSignIn(`MTR-00000${installationId.slice(-1)}`, secretOf(installationId));
    expect(res.status).toBe(201);
    expect(verify(res.body.access_token).sub).toBe(installationId);
  });

  test('two sign-ins give two different tokens', async () => {
    const a = (await meterSignIn('MTR-000001', secretOf('INS-0001'))).body.access_token;
    const b = (await meterSignIn('MTR-000001', secretOf('INS-0001'))).body.access_token;
    expect(a).not.toBe(b);
  });

  test('the token never contains the device secret or its hash', async () => {
    const { access_token: token } = (await meterSignIn('MTR-000001', secretOf('INS-0001'))).body;
    const payload = JSON.stringify(jwt.decode(token));
    expect(payload).not.toContain(secretOf('INS-0001'));
    expect(payload).not.toContain('$2');
  });
});

describe('401: wrong credentials, one answer for every case', () => {
  const expect401 = (res) => {
    expectErrorBody(res, 401, 'INVALID_CREDENTIALS');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="slsea-solar-api"');
  };

  test('wrong secret → 401', async () => {
    expect401(await meterSignIn('MTR-000001', 'not-the-secret'));
  });

  test('another installation\'s secret → 401 (a secret only works with its own meter)', async () => {
    expect401(await meterSignIn('MTR-000001', secretOf('INS-0002')));
  });

  test('unknown meter → exactly the same body as a wrong secret, and bcrypt still runs', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    const unknown = await meterSignIn('MTR-999999', 'anything');
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
    expect401(unknown);
    expect(unknown.body).toEqual((await meterSignIn('MTR-000001', 'not-the-secret')).body);
  });

  test('a deleted installation\'s meter → 401, like an unknown meter', async () => {
    expect((await asAdmin(app).delete('/installations/INS-0005')).status).toBe(200);
    expect401(await meterSignIn('MTR-000005', secretOf('INS-0005')));
  });

  test('an installation registered through the API (no secret issued yet) → 401, not 500', async () => {
    const created = await asAdmin(app).post('/installations').send({
      installation_id: 'INS-0006', name: 'Kolonnawa test rooftop 6', meter_id: 'MTR-000006', substation_id: 'SS-001',
      capacity_kw: 5, status: 'active', commissioned_at: '2026-10-01T00:00:00Z', address: 'No. 6, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
    });
    expect(created.status).toBe(201);
    expect401(await meterSignIn('MTR-000006', 'any-secret'));
  });

  test('the secret is never echoed in the error', async () => {
    const res = await meterSignIn('MTR-000001', 'my-secret-guess');
    expect(JSON.stringify(res.body)).not.toContain('my-secret-guess');
  });
});

describe('403: an inactive installation cannot get a token', () => {
  test('INS-0004 (inactive) with its correct secret → 403 ACCOUNT_INACTIVE, no token', async () => {
    const res = await meterSignIn('MTR-000004', secretOf('INS-0004'));
    expectErrorBody(res, 403, 'ACCOUNT_INACTIVE');
    expect(res.body.access_token).toBeUndefined();
  });

  test('INS-0004 with a wrong secret → 401, not 403 (status is only revealed to the real meter)', async () => {
    expectErrorBody(await meterSignIn('MTR-000004', 'wrong'), 401, 'INVALID_CREDENTIALS');
  });

  test('deactivating an installation (PUT status inactive) stops its meter getting tokens; reactivating restores it', async () => {
    const full = {
      name: 'Kolonnawa test rooftop 1', meter_id: 'MTR-000001', substation_id: 'SS-001', capacity_kw: 5,
      commissioned_at: '2024-01-15T00:00:00Z', address: 'No. 1, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
    };
    expect((await asAdmin(app).put('/installations/INS-0001').send({ ...full, status: 'inactive' })).status).toBe(200);
    expectErrorBody(await meterSignIn('MTR-000001', secretOf('INS-0001')), 403, 'ACCOUNT_INACTIVE');

    expect((await asAdmin(app).put('/installations/INS-0001').send({ ...full, status: 'active' })).status).toBe(200);
    expect((await meterSignIn('MTR-000001', secretOf('INS-0001'))).status).toBe(201);
  });
});

describe('400: exactly one well-formed credential pair', () => {
  const expect400 = async (body, details) => {
    const res = await request(app).post('/auth/tokens').send(body);
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual(details.map((d) => ({ ...d, location: 'body', reference: null })));
  };

  test('no device_secret → Required', async () => {
    await expect400({ meter_id: 'MTR-000001' }, [{ field: 'device_secret', issue: 'Required.' }]);
  });

  test('no meter_id → Required', async () => {
    await expect400({ device_secret: 'x' }, [{ field: 'meter_id', issue: 'Required.' }]);
  });

  test.each(['MTR-1', 'mtr-000001', 'INS-0001', 123])('a malformed meter_id (%s) → 400', async (meterId) => {
    await expect400({ meter_id: meterId, device_secret: 'x' }, [{ field: 'meter_id', issue: 'Must look like MTR-000001.' }]);
  });

  test('a secret over 72 bytes, empty, or not text → 400', async () => {
    for (const secret of ['é'.repeat(37), '', 42]) {
      await expect400({ meter_id: 'MTR-000001', device_secret: secret }, [{ field: 'device_secret', issue: 'Must be text of 1 to 72 bytes.' }]);
    }
  });

  test('an extra field with a meter pair → 400 (e.g. trying to pick the installation)', async () => {
    await expect400(
      { meter_id: 'MTR-000001', device_secret: secretOf('INS-0001'), installation_id: 'INS-0002' },
      [{ field: 'installation_id', issue: 'Not an accepted field.' }]
    );
  });

  test.each([
    ['email + meter_id', { email: 'national@test.example', meter_id: 'MTR-000001' }],
    ['password + device_secret', { password: 'x', device_secret: 'y' }],
    ['both full pairs', { email: 'national@test.example', password: 'test-national-pass', meter_id: 'MTR-000001', device_secret: secretOf('INS-0001') }],
  ])('a mix of the two pairs (%s) → 400, never a token', async (_, body) => {
    await expect400(body, [{ field: null, issue: 'Send one credential pair: email + password, or meter_id + device_secret, not both.' }]);
  });
});

describe('the user sign-in from Step 9.2 is unaffected', () => {
  test('email + password still gives an analyst token', async () => {
    const res = await request(app).post('/auth/tokens').send({ email: 'colombo@test.example', password: 'test-colombo-pass' });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe('analyst-read-by-jurisdiction');
  });

  test('the stored hash is the only thing compared: a seeded installation has one', async () => {
    expect((await SolarInstallation.findById('INS-0001').select('+device_secret_hash')).device_secret_hash).toMatch(/^\$2[aby]\$/);
  });
});
