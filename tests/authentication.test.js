const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const { testToken } = require('./helpers/authed-request');

// Step 9.4: authentication only (is there a valid token?). What each token may do is Step 9.5.
beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
});
afterAll(tearDownTestDatabase);

const REALM = 'Bearer realm="slsea-solar-api"';
const INVALID = `${REALM}, error="invalid_token", error_description="The token is not valid"`;
const EXPIRED = `${REALM}, error="invalid_token", error_description="The token has expired"`;
const now = () => Math.floor(Date.now() / 1000);

// A token exactly like the API's, with any field overridden, to make each kind of bad token.
// An option set to undefined is removed (e.g. expiresIn, when the payload sets exp itself).
function craft({ payload = {}, secret = process.env.JWT_SECRET, algorithm = 'HS256', options = {} } = {}) {
  const signOptions = { algorithm, issuer: 'slsea-solar-api/auth', audience: 'slsea-solar-api', expiresIn: 3600, ...options };
  for (const key of Object.keys(signOptions)) if (signOptions[key] === undefined) delete signOptions[key];
  return jwt.sign(
    { sub: 'USR-001', scope: 'analyst-read-by-jurisdiction', jurisdiction: { level: 'national', id: null }, ...payload },
    secret,
    signOptions
  );
}
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// One route per guarded area, every method in use, plus the 405 answers.
const GUARDED = [
  ['get', '/provinces'],
  ['get', '/provinces/PV-01'],
  ['get', '/provinces/PV-01/generation-summary'],
  ['get', '/districts'],
  ['get', '/districts/DT-01'],
  ['get', '/districts/DT-01/generation-summary'],
  ['get', '/grid-substations'],
  ['get', '/grid-substations/SS-001'],
  ['get', '/installations'],
  ['get', '/installations/INS-0001'],
  ['head', '/installations/INS-0001'],
  ['get', '/installations/INS-0001/last-known-reading'],
  ['get', '/installations/INS-0001/readings'],
  ['get', '/installations/INS-0001/readings/000000000000000000000005'],
  ['post', '/installations/INS-0001/readings'],
  ['post', '/installations'],
  ['put', '/installations/INS-0001'],
  ['delete', '/installations/INS-0001'],
  ['patch', '/installations/INS-0001'],
  ['delete', '/installations/INS-0001/readings'],
  ['post', '/districts/DT-01/generation-summary'],
];

function expect401(res, code, challenge) {
  expect(res.status).toBe(401);
  expect(res.headers['www-authenticate']).toBe(challenge);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers.etag).toBeUndefined();
  if (res.request.method !== 'HEAD') expectErrorBody(res, 401, code);
}

describe('no token → 401 AUTHENTICATION_REQUIRED with WWW-Authenticate: Bearer', () => {
  test.each(GUARDED)('%s %s', async (method, path) => {
    expect401(await request(app)[method](path), 'AUTHENTICATION_REQUIRED', REALM);
  });

  test.each([
    ['another scheme (Basic)', 'Basic bmF0aW9uYWxAdGVzdC5leGFtcGxlOnRlc3QtbmF0aW9uYWwtcGFzcw=='],
    ['an API key style header value', 'ApiKey abc123'],
    ['"Bearer" with no token', 'Bearer'],
    ['"Bearer" and spaces only', 'Bearer    '],
    ['an empty header', ''],
  ])('%s → 401 AUTHENTICATION_REQUIRED', async (_, header) => {
    expect401(await request(app).get('/provinces').set('Authorization', header), 'AUTHENTICATION_REQUIRED', REALM);
  });
});

describe('a token that is not acceptable → 401 with error="invalid_token"', () => {
  test.each([
    ['not a JWT at all', 'abc'],
    ['three parts of rubbish', 'aaa.bbb.ccc'],
    ['signed with another secret', craft({ secret: 'z'.repeat(64) })],
    ['another issuer', craft({ options: { issuer: 'someone-else' } })],
    ['another audience', craft({ options: { audience: 'another-api' } })],
    ['the right secret but HS512 (the algorithm is pinned)', craft({ algorithm: 'HS512' })],
    ['alg "none" (unsigned)', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'USR-007', scope: 'asset-admin', iss: 'slsea-solar-api/auth', aud: 'slsea-solar-api', exp: now() + 3600 })}.`],
    ['the payload edited after signing (scope raised to asset-admin)', (() => {
      const [h, , sig] = craft().split('.');
      return `${h}.${b64({ sub: 'USR-001', scope: 'asset-admin', iss: 'slsea-solar-api/auth', aud: 'slsea-solar-api', exp: now() + 3600 })}.${sig}`;
    })()],
    ['no exp (would never expire)', jwt.sign({ sub: 'USR-001', scope: 'analyst-read-by-jurisdiction' }, process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'slsea-solar-api/auth', audience: 'slsea-solar-api' })],
    ['no sub', craft({ payload: { sub: undefined } })],
    ['no scope', craft({ payload: { scope: undefined } })],
    ['not valid yet (nbf in the future)', craft({ options: { notBefore: 3600 } })],
  ])('%s → 401 INVALID_TOKEN', async (_, token) => {
    expect401(await request(app).get('/provinces').set('Authorization', `Bearer ${token}`), 'INVALID_TOKEN', INVALID);
  });

  test('expired (beyond the 30 s tolerance) → 401 TOKEN_EXPIRED', async () => {
    const token = craft({ payload: { iat: now() - 7200, exp: now() - 60 }, options: { expiresIn: undefined } });
    expect401(await request(app).get('/provinces').set('Authorization', `Bearer ${token}`), 'TOKEN_EXPIRED', EXPIRED);
  });

  test('expired 10 s ago (inside the 30 s clock tolerance) → accepted', async () => {
    const token = craft({ payload: { iat: now() - 3600, exp: now() - 10 }, options: { expiresIn: undefined } });
    expect((await request(app).get('/provinces').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  test('the token is never echoed back in the error', async () => {
    const token = craft({ secret: 'z'.repeat(64) });
    const res = await request(app).get('/provinces').set('Authorization', `Bearer ${token}`);
    expect(JSON.stringify(res.body) + res.headers['www-authenticate']).not.toContain(token);
  });
});

describe('a valid token is accepted', () => {
  test('a token from POST /auth/tokens opens a guarded route', async () => {
    const signIn = await request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'test-national-pass' });
    const res = await request(app).get('/provinces').set('Authorization', `Bearer ${signIn.body.access_token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.province_id)).toEqual(['PV-01', 'PV-02']);
  });

  test('the scheme name is case-insensitive ("bearer", "BEARER")', async () => {
    for (const scheme of ['bearer', 'BEARER']) {
      expect((await request(app).get('/provinces').set('Authorization', `${scheme} ${testToken()}`)).status).toBe(200);
    }
  });

  test('a device token passes authentication: refused by scope (403), not as unauthenticated (401)', async () => {
    const signIn = await request(app).post('/auth/tokens').send({ meter_id: 'MTR-000001', device_secret: 'test-device-secret-INS-0001' });
    expect((await request(app).get('/provinces').set('Authorization', `Bearer ${signIn.body.access_token}`)).status).toBe(403);
  });
});

describe('the order: 401 comes before anything that would reveal more', () => {
  test('before 404: a missing installation looks the same as an existing one', async () => {
    const missing = await request(app).get('/installations/INS-9999');
    const existing = await request(app).get('/installations/INS-0001');
    expect401(missing, 'AUTHENTICATION_REQUIRED', REALM);
    expect(missing.body).toEqual(existing.body);
  });

  test('before 405: which methods a URI allows is not revealed', async () => {
    const res = await request(app).put('/installations/INS-0001/readings');
    expect401(res, 'AUTHENTICATION_REQUIRED', REALM);
    expect(res.headers.allow).toBeUndefined();
  });

  test('before 406, 415 and 400', async () => {
    expect401(await request(app).get('/provinces').set('Accept', 'text/html'), 'AUTHENTICATION_REQUIRED', REALM);
    expect401(await request(app).post('/installations/INS-0001/readings').type('text').send('x'), 'AUTHENTICATION_REQUIRED', REALM);
    expect401(await request(app).get('/installations?page-size=0'), 'AUTHENTICATION_REQUIRED', REALM);
  });

  test('the same order with a token: 406 still works once authenticated', async () => {
    expectErrorBody(await request(app).get('/provinces').set('Authorization', `Bearer ${testToken()}`).set('Accept', 'text/html'), 406, 'NOT_ACCEPTABLE');
  });
});

describe('what stays public', () => {
  test('/health, /api-docs and POST /auth/tokens need no token', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/api-docs/')).status).toBe(200);
    expect((await request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'test-national-pass' })).status).toBe(201);
  });

  test('a path that is no resource at all is still 404, not 401', async () => {
    expectErrorBody(await request(app).get('/no-such-thing'), 404, 'ROUTE_NOT_FOUND');
  });

  test('a token on a public route is simply ignored, even an invalid one', async () => {
    expect((await request(app).get('/health').set('Authorization', 'Bearer rubbish')).status).toBe(200);
  });
});

describe('a missing signing secret is a server fault, not the client\'s', () => {
  test('→ 500 INTERNAL_ERROR, not 401', async () => {
    const token = testToken();
    const saved = process.env.JWT_SECRET;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.JWT_SECRET;
    try {
      expectErrorBody(await request(app).get('/provinces').set('Authorization', `Bearer ${token}`), 500, 'INTERNAL_ERROR');
    } finally {
      process.env.JWT_SECRET = saved;
      quiet.mockRestore();
    }
  });
});
