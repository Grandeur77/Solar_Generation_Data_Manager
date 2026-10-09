// Logging is off under Jest by default; this file turns it on to check what is written.
process.env.LOG_REQUESTS = 'true';

const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { adminToken } = require('./helpers/authed-request');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
});
afterAll(async () => {
  delete process.env.LOG_REQUESTS;
  await tearDownTestDatabase();
});

// Everything the app writes to stdout and stderr while fn runs, as raw text and as parsed log lines.
async function captureLogs(fn) {
  const raw = [];
  const keep = (chunk) => {
    raw.push(String(chunk));
    return true;
  };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(keep);
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(keep);
  try {
    await fn();
    // The log line is written when the response finishes; give that event a moment.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  const text = raw.join('');
  const lines = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((l) => l.request_id);
  return { text, lines };
}

describe('X-Request-Id on every response', () => {
  test.each([
    ['public, 200', () => request(app).get('/health')],
    ['docs page', () => request(app).get('/api-docs/')],
    ['no such route, 404', () => request(app).get('/no-such-thing')],
    ['no token, 401', () => request(app).get('/provinces')],
    ['authenticated, 200', () => request(app).get('/provinces').set('Authorization', `Bearer ${adminToken()}`)],
    ['method not allowed, 405', () => request(app).patch('/installations/INS-0001').set('Authorization', `Bearer ${adminToken()}`)],
    ['sign-in, 201', () => request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'test-national-pass' })],
  ])('%s', async (_, send) => {
    expect((await send()).headers['x-request-id']).toMatch(UUID);
  });

  test('a 304 carries it too', async () => {
    const first = await request(app).get('/provinces/PV-01').set('Authorization', `Bearer ${adminToken()}`);
    const again = await request(app).get('/provinces/PV-01').set('Authorization', `Bearer ${adminToken()}`).set('If-None-Match', first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.headers['x-request-id']).toMatch(UUID);
  });

  test('every request gets its own id', async () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) ids.add((await request(app).get('/health')).headers['x-request-id']);
    expect(ids.size).toBe(5);
  });

  test.each(['abc-123', 'bom1::iad1::k7x2-1700000000000-abcdef', 'trace.42_A'])('a safe incoming id is kept: %s', async (id) => {
    expect((await request(app).get('/health').set('X-Request-Id', id)).headers['x-request-id']).toBe(id);
  });

  test.each(['has space', 'x'.repeat(129), 'quote"inside', 'semi;colon', '<script>', '{"level":"error"}'])(
    'an unsafe incoming id is replaced with a new one: %s',
    async (id) => {
      const res = await request(app).get('/health').set('X-Request-Id', id);
      expect(res.headers['x-request-id']).toMatch(UUID);
    }
  );
});

describe('one structured log line per request', () => {
  test('the fields, matching the response\'s X-Request-Id', async () => {
    let res;
    const { lines } = await captureLogs(async () => {
      res = await request(app).get('/installations/INS-0001').set('Authorization', `Bearer ${adminToken()}`);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      level: 'info',
      request_id: res.headers['x-request-id'],
      method: 'GET',
      path: '/installations/INS-0001',
      status: 200,
      duration_ms: expect.any(Number),
      subject: 'USR-007',
      scope: 'asset-admin analyst-read-by-jurisdiction',
    });
  });

  test('4xx is logged as warn; an unauthenticated request has no subject or scope', async () => {
    const { lines } = await captureLogs(() => request(app).get('/provinces'));
    expect(lines[0]).toMatchObject({ level: 'warn', status: 401, path: '/provinces' });
    expect(lines[0]).not.toHaveProperty('subject');
    expect(lines[0]).not.toHaveProperty('scope');
  });

  test('the incoming id is the one logged, so a client can quote it', async () => {
    const { lines } = await captureLogs(() => request(app).get('/health').set('X-Request-Id', 'support-ticket-7'));
    expect(lines[0].request_id).toBe('support-ticket-7');
  });

  test('each line is a single line of JSON, even with an unsafe incoming id', async () => {
    const { text } = await captureLogs(() => request(app).get('/health').set('X-Request-Id', '{"level":"error","fake":true}'));
    const written = text.split('\n').filter(Boolean);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).fake).toBeUndefined();
  });
});

describe('never logs tokens, passwords or device secrets', () => {
  test('sign-in with a password, a meter sign-in, a request with the token, and a query string', async () => {
    const password = 'test-national-pass';
    const secret = 'test-device-secret-INS-0001';
    let userToken;
    let meterToken;
    const { text, lines } = await captureLogs(async () => {
      userToken = (await request(app).post('/auth/tokens').send({ email: 'national@test.example', password })).body.access_token;
      meterToken = (await request(app).post('/auth/tokens').send({ meter_id: 'MTR-000001', device_secret: secret })).body.access_token;
      await request(app).post('/auth/tokens').send({ email: 'national@test.example', password: 'a-wrong-guess' });
      await request(app).get('/installations?status=active&page-size=2').set('Authorization', `Bearer ${userToken}`);
      await request(app).get(`/provinces?note=${encodeURIComponent('query-value-should-not-be-logged')}`).set('Authorization', `Bearer ${userToken}`);
    });
    expect(lines).toHaveLength(5);
    for (const forbidden of [password, secret, 'a-wrong-guess', userToken, meterToken, 'query-value-should-not-be-logged', 'Bearer', 'national@test.example']) {
      expect(text).not.toContain(forbidden);
    }
    // The query string is dropped entirely: only the path is logged.
    expect(lines[3].path).toBe('/installations');
  });

  test('a token pasted into the path is redacted', async () => {
    const token = adminToken();
    const { text, lines } = await captureLogs(() => request(app).get(`/installations/${token}`).set('Authorization', `Bearer ${token}`));
    expect(lines[0].path).toBe('/installations/[redacted]');
    expect(text).not.toContain(token);
  });
});

describe('switching logging off', () => {
  test('LOG_REQUESTS=false writes nothing', async () => {
    process.env.LOG_REQUESTS = 'false';
    try {
      const { lines } = await captureLogs(() => request(app).get('/health'));
      expect(lines).toEqual([]);
    } finally {
      process.env.LOG_REQUESTS = 'true';
    }
  });

  test('under Jest with no LOG_REQUESTS, nothing is written (other test files stay quiet)', async () => {
    delete process.env.LOG_REQUESTS;
    try {
      const { lines } = await captureLogs(() => request(app).get('/health'));
      expect(lines).toEqual([]);
    } finally {
      process.env.LOG_REQUESTS = 'true';
    }
  });
});
