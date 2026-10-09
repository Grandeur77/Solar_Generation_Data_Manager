// One allowed browser origin for this file, set before the app (and its CORS policy) is loaded.
process.env.CORS_ORIGINS = 'https://dashboard.example';

const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const asClient = require('./helpers/authed-request');
const { adminToken, deviceToken } = require('./helpers/authed-request');

beforeAll(setUpTestDatabase);
beforeEach(loadTestSeed);
afterAll(tearDownTestDatabase);

const ALLOWED = 'https://dashboard.example';
const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken()}`);
const INSTALLATION = {
  installation_id: 'INS-0006', name: 'Kolonnawa test rooftop 6', meter_id: 'MTR-000006', substation_id: 'SS-001',
  capacity_kw: 5, status: 'active', commissioned_at: '2026-10-01T00:00:00Z', address: 'No. 6, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
};

describe('NoSQL-injection guard: keys that could act as MongoDB operators are refused (400)', () => {
  const problem = (field, location) => ({ field, location, issue: 'Keys containing $ or . are not accepted.', reference: null });

  test('the classic login bypass {"$ne": null} on POST /auth/tokens', async () => {
    const res = await request(app).post('/auth/tokens').send({ email: { $ne: null }, password: { $gt: '' } });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([problem('email.$ne', 'body'), problem('password.$gt', 'body')]);
    expect(res.body.access_token).toBeUndefined();
  });

  test('an operator inside a reading body (after the device\'s scope checks)', async () => {
    const res = await asClient(app).post('/installations/INS-0001/readings').send({ timestamp: '2026-10-06T12:45:00Z', power_kw: { $gt: 0 }, energy_kwh: 1021, voltage: 230 });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([problem('power_kw.$gt', 'body')]);
  });

  test('found at any depth, inside arrays too, and dotted keys', async () => {
    const res = await asClient(app).post('/installations').send({ ...INSTALLATION, extra: [{ $where: 'sleep(1000)' }], 'meter.id': 'x' });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([problem('extra[0].$where', 'body'), problem('meter.id', 'body')]);
  });

  test('in a query string: ?status[$ne]=active and ?a.b=1', async () => {
    const res = await asAdmin(request(app).get('/installations?status[$ne]=active&a.b=1'));
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([problem('status[$ne]', 'query'), problem('a.b', 'query')]);
  });

  test('a $ inside a value is just text: ordinary validation applies', async () => {
    expectErrorBody(await asAdmin(request(app).get('/installations?status=$active')), 400, 'INVALID_QUERY_PARAMETER');
    const created = await asClient(app).post('/installations').send({ ...INSTALLATION, name: 'Site $1 (rooftop.solar)' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Site $1 (rooftop.solar)');
  });
});

describe('helmet: security headers on every response', () => {
  const expectSecurityHeaders = (res) => {
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
  };

  test('a JSON resource, an error, the token endpoint and /health all carry them', async () => {
    expectSecurityHeaders(await asAdmin(request(app).get('/provinces')));
    expectSecurityHeaders(await request(app).get('/provinces'));
    expectSecurityHeaders(await request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'test-national-pass' }));
    expectSecurityHeaders(await request(app).get('/health'));
  });

  test('the docs page: scripts only from itself and the pinned CDN, never inline', async () => {
    const page = await request(app).get('/api-docs/');
    expect(page.status).toBe(200);
    const csp = page.headers['content-security-policy'];
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self' https://cdn.jsdelivr.net");
    // Every <script> in the page loads a file; there is no inline script for the policy to allow.
    expect(page.text.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();

    const init = await request(app).get('/api-docs/init.js');
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toMatch(/^application\/javascript/);
    expect(init.text).toContain("SwaggerUIBundle({ url: '/api-docs/openapi'");
  });
});

describe('restricted CORS: only listed browser origins, exact match', () => {
  test('no Origin (a meter, curl, a server): no CORS headers, the request works as usual', async () => {
    const res = await asAdmin(request(app).get('/provinces'));
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('an allowed origin: echoed back, useful headers exposed, no credentials, Vary: Origin', async () => {
    const res = await asAdmin(request(app).get('/provinces').set('Origin', ALLOWED));
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-expose-headers']).toBe('ETag,Last-Modified,Location,Retry-After,WWW-Authenticate,Allow');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers.vary).toMatch(/\bOrigin\b/);
  });

  test.each(['https://evil.example', 'http://dashboard.example', 'https://dashboard.example.evil.com', 'null'])('a different origin (%s) gets no CORS headers, so the browser blocks it', async (origin) => {
    const res = await asAdmin(request(app).get('/provinces').set('Origin', origin));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a preflight from the allowed origin is answered without a token (204, methods and headers listed)', async () => {
    const res = await request(app)
      .options('/installations/INS-0001')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type, If-Match');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,POST,PUT,DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization,Content-Type,Accept,If-Match,If-None-Match,If-Modified-Since');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  test('a preflight from another origin gets no CORS headers', async () => {
    const res = await request(app).options('/installations/INS-0001').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'DELETE');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });
});

describe('Cache-Control: private and Vary: Accept, Authorization on every scoped response', () => {
  const expectPrivate = (res) => {
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toMatch(/\bAccept\b/);
    expect(res.headers.vary).toMatch(/\bAuthorization\b/);
  };

  test('GET 200 and its 304', async () => {
    const first = await asAdmin(request(app).get('/installations/INS-0001'));
    expectPrivate(first);
    const again = await asAdmin(request(app).get('/installations/INS-0001').set('If-None-Match', first.headers.etag));
    expect(again.status).toBe(304);
    expectPrivate(again);
  });

  test('writes too: POST reading 201, POST installation 201, PUT 200, DELETE 200', async () => {
    const reading = await request(app).post('/installations/INS-0001/readings').set('Authorization', `Bearer ${deviceToken('INS-0001')}`)
      .send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.4, energy_kwh: 1021, voltage: 230 });
    expect(reading.status).toBe(201);
    expectPrivate(reading);
    const created = await asClient(app).post('/installations').send(INSTALLATION);
    expect(created.status).toBe(201);
    expectPrivate(created);
    const { installation_id: _ignored, ...replacement } = { ...INSTALLATION, name: 'Renamed' };
    const replaced = await asClient(app).put('/installations/INS-0006').send(replacement);
    expect(replaced.status).toBe(200);
    expectPrivate(replaced);
    const removed = await asClient(app).delete('/installations/INS-0006');
    expect(removed.status).toBe(200);
    expectPrivate(removed);
  });

  test('errors on scoped paths: no-store (never cached), still Vary: Authorization', async () => {
    for (const res of [
      await request(app).get('/provinces'), // 401
      await request(app).get('/provinces').set('Authorization', `Bearer ${deviceToken('INS-0001')}`), // 403
      await asAdmin(request(app).get('/installations/INS-9999')), // 404
    ]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.vary).toMatch(/\bAuthorization\b/);
    }
  });

  test('the token response stays no-store (a credential is never kept by any cache)', async () => {
    const res = await request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'test-national-pass' });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
