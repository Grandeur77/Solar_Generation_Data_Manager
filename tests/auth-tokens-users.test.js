const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { validateTokenRequest } = require('../src/utils/validate-credentials');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Test users (tests/fixtures/test-seed.js), all with test-only passwords:
//   USR-001 national analyst, USR-002 Western (PV-01) analyst, USR-004 Colombo (DT-01) analyst,
//   USR-006 Kandy analyst (inactive), USR-007 registry admin (national).
beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
});
afterAll(tearDownTestDatabase);

const signIn = (body) => request(app).post('/auth/tokens').send(body);
// Verified exactly as the API will verify it (Step 9.4): algorithm pinned, iss and aud checked.
const verify = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'slsea-solar-api/auth', audience: 'slsea-solar-api' });

describe('201: a signed token for each kind of user', () => {
  test.each([
    ['national analyst', 'national@test.example', 'test-national-pass', 'USR-001', { level: 'national', id: null }],
    ['province analyst', 'western@test.example', 'test-western-pass', 'USR-002', { level: 'province', id: 'PV-01' }],
    ['district analyst', 'colombo@test.example', 'test-colombo-pass', 'USR-004', { level: 'district', id: 'DT-01' }],
  ])('%s → analyst-read-by-jurisdiction for 1 h, carrying the jurisdiction', async (_, email, password, sub, jurisdiction) => {
    const res = await signIn({ email, password });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ access_token: expect.any(String), token_type: 'Bearer', expires_in: 3600, scope: 'analyst-read-by-jurisdiction' });

    const claims = verify(res.body.access_token);
    expect(claims).toEqual({
      sub,
      scope: 'analyst-read-by-jurisdiction',
      jurisdiction,
      iss: 'slsea-solar-api/auth',
      aud: 'slsea-solar-api',
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(claims.exp - claims.iat).toBe(3600);
  });

  test('registry admin → asset-admin plus read, for 15 minutes, national', async () => {
    const res = await signIn({ email: 'admin@test.example', password: 'test-admin-pass' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'asset-admin analyst-read-by-jurisdiction' });
    const claims = verify(res.body.access_token);
    expect(claims).toMatchObject({ sub: 'USR-007', scope: 'asset-admin analyst-read-by-jurisdiction', jurisdiction: { level: 'national', id: null } });
    expect(claims.exp - claims.iat).toBe(900);
  });

  test('the token holds no personal data: no email, name, role or password hash', async () => {
    const { access_token: token } = (await signIn({ email: 'colombo@test.example', password: 'test-colombo-pass' })).body;
    const claims = jwt.decode(token);
    // Exactly these claims and nothing else (no role claim: the scope says what is allowed).
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'jurisdiction', 'scope', 'sub']);
    const payload = JSON.stringify(claims);
    for (const text of ['colombo@test.example', 'Test Colombo', 'password', '$2']) {
      expect(payload).not.toContain(text);
    }
    expect(jwt.decode(token, { complete: true }).header).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  test('201 with Cache-Control: no-store, and no Location, ETag or Last-Modified (the token is not stored)', async () => {
    const res = await signIn({ email: 'national@test.example', password: 'test-national-pass' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.location).toBeUndefined();
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  test('two identical sign-ins create two different tokens (POST is not idempotent here)', async () => {
    const body = { email: 'national@test.example', password: 'test-national-pass' };
    const [a, b] = [(await signIn(body)).body.access_token, (await signIn(body)).body.access_token];
    expect(a).not.toBe(b);
    expect(verify(a).jti).not.toBe(verify(b).jti);
  });

  test('the email is case-insensitive and surrounding spaces are ignored', async () => {
    const res = await signIn({ email: '  Colombo@TEST.example ', password: 'test-colombo-pass' });
    expect(res.status).toBe(201);
    expect(verify(res.body.access_token).sub).toBe('USR-004');
  });

  // Mongoose also lowercases and trims the email in the query (the User schema's setters), so the
  // HTTP test above passes either way; this pins the validator's own normalisation.
  test('the validator itself returns the email trimmed and lowercased', () => {
    expect(validateTokenRequest({ email: '  Colombo@TEST.example ', password: 'x' }).email).toBe('colombo@test.example');
  });

  test('a token signed with another secret does not verify (the signature is real)', async () => {
    const forged = jwt.sign({ scope: 'asset-admin' }, 'x'.repeat(64), { algorithm: 'HS256', issuer: 'slsea-solar-api/auth', audience: 'slsea-solar-api', subject: 'USR-007' });
    expect(() => verify(forged)).toThrow(/invalid signature/);
  });
});

describe('401: wrong credentials, one answer for every case', () => {
  const expect401 = (res) => {
    expectErrorBody(res, 401, 'INVALID_CREDENTIALS');
    expect(res.headers['www-authenticate']).toBe('Bearer realm="slsea-solar-api"');
    expect(res.headers['cache-control']).toBe('no-store');
  };

  test('wrong password → 401 INVALID_CREDENTIALS with WWW-Authenticate', async () => {
    expect401(await signIn({ email: 'colombo@test.example', password: 'wrong-password' }));
  });

  test('unknown email → exactly the same response, so it does not reveal which accounts exist', async () => {
    const wrong = await signIn({ email: 'colombo@test.example', password: 'wrong-password' });
    const unknown = await signIn({ email: 'nobody@test.example', password: 'wrong-password' });
    expect401(unknown);
    expect(unknown.body).toEqual(wrong.body);
  });

  test('an unknown email still runs a bcrypt comparison (no timing shortcut)', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    await signIn({ email: 'nobody@test.example', password: 'whatever' });
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  test('the password is never echoed in the error', async () => {
    const res = await signIn({ email: 'colombo@test.example', password: 'my-secret-guess' });
    expect(JSON.stringify(res.body)).not.toContain('my-secret-guess');
  });
});

describe('403: an inactive user', () => {
  test('correct password, inactive account → 403 ACCOUNT_INACTIVE, no token', async () => {
    const res = await signIn({ email: 'kandy@test.example', password: 'test-kandy-pass' });
    expectErrorBody(res, 403, 'ACCOUNT_INACTIVE');
    expect(res.body.access_token).toBeUndefined();
  });

  test('wrong password on an inactive account → 401, not 403 (status is only revealed to the real owner)', async () => {
    expectErrorBody(await signIn({ email: 'kandy@test.example', password: 'wrong-password' }), 401, 'INVALID_CREDENTIALS');
  });
});

describe('400: the body is checked before any account is looked up', () => {
  test.each([
    ['no password', { email: 'national@test.example' }, [{ field: 'password', issue: 'Required.' }]],
    ['no email', { password: 'x' }, [{ field: 'email', issue: 'Required.' }]],
    ['empty body', {}, [{ field: 'email', issue: 'Required.' }, { field: 'password', issue: 'Required.' }]],
    ['not an email', { email: 'national', password: 'x' }, [{ field: 'email', issue: 'Must be an email address.' }]],
    ['password not text', { email: 'national@test.example', password: 12345 }, [{ field: 'password', issue: 'Must be text of 1 to 72 bytes.' }]],
    ['empty password', { email: 'national@test.example', password: '' }, [{ field: 'password', issue: 'Must be text of 1 to 72 bytes.' }]],
    // 37 × "é" is 37 characters but 74 bytes: bcrypt would silently ignore the last 2.
    ['password over 72 bytes', { email: 'national@test.example', password: 'é'.repeat(37) }, [{ field: 'password', issue: 'Must be text of 1 to 72 bytes.' }]],
    ['an extra field', { email: 'national@test.example', password: 'x', role: 'registry_admin' }, [{ field: 'role', issue: 'Not an accepted field.' }]],
  ])('%s → 400 VALIDATION_FAILED', async (_, body, expected) => {
    const res = await signIn(body);
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual(expected.map((e) => ({ ...e, location: 'body', reference: null })));
  });

  test('exactly 72 bytes is accepted as a well-formed password (then simply wrong → 401)', async () => {
    expectErrorBody(await signIn({ email: 'national@test.example', password: 'a'.repeat(72) }), 401, 'INVALID_CREDENTIALS');
  });

  test.each([['an array', []], ['null', null], ['a number', 42]])('%s as the body → 400', async (_, body) => {
    const res = await request(app).post('/auth/tokens').set('Content-Type', 'application/json').send(JSON.stringify(body));
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
  });

  test('malformed JSON → 400 INVALID_JSON; a form body → 415; Accept: text/html → 406', async () => {
    expectErrorBody(await request(app).post('/auth/tokens').set('Content-Type', 'application/json').send('{"email":'), 400, 'INVALID_JSON');
    expectErrorBody(await request(app).post('/auth/tokens').type('form').send({ email: 'national@test.example', password: 'x' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    expectErrorBody(await signIn({ email: 'national@test.example', password: 'x' }).set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
  });
});

describe('405: tokens can only be created', () => {
  test.each(['get', 'put', 'patch', 'delete'])('%s /auth/tokens → 405, Allow: POST', async (method) => {
    const res = await request(app)[method]('/auth/tokens');
    expectErrorBody(res, 405, 'METHOD_NOT_ALLOWED');
    expect(res.headers.allow).toBe('POST');
  });
});

describe('a missing or weak signing secret fails safely', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([['missing', undefined], ['shorter than 32 characters', 'too-short']])('%s → 500 INTERNAL_ERROR, no token, nothing leaked', async (_, value) => {
    const saved = process.env.JWT_SECRET;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;
    try {
      const res = await signIn({ email: 'national@test.example', password: 'test-national-pass' });
      expectErrorBody(res, 500, 'INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/JWT_SECRET|secret/i);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});
