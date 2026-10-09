const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');

beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const R5 = '000000000000000000000005';
// One of each kind of GET resource.
const RESOURCES = [
  '/provinces',
  '/provinces/PV-01',
  '/districts?province-id=PV-01',
  '/districts/DT-01',
  '/grid-substations',
  '/grid-substations/SS-001',
  '/installations',
  '/installations?status=active&page-size=2',
  '/installations/INS-0001',
  '/installations/INS-0001/last-known-reading',
  '/installations/INS-0001/readings',
  `/installations/INS-0001/readings/${R5}`,
];

// A 304 Not Modified: no body at all, and no Content-Type, but the validators are still sent.
function expectNotModified(res) {
  expect(res.status).toBe(304);
  expect(res.text || '').toBe(''); // supertest gives undefined for HEAD, '' for GET: both mean no body
  expect(res.headers['content-type']).toBeUndefined();
  expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  expect(res.headers['cache-control']).toBe('private, no-cache');
}

describe('every GET resource has a strong ETag, Last-Modified and caching headers', () => {
  test.each(RESOURCES)('%s', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/); // strong: quoted, no W/ prefix
    expect(new Date(res.headers['last-modified']).toUTCString()).toBe(res.headers['last-modified']);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Accept, Authorization');
  });
});

describe('If-None-Match → 304 with an empty body', () => {
  test.each(RESOURCES)('%s with its own ETag → 304, empty body', async (path) => {
    const first = await request(app).get(path);
    const res = await request(app).get(path).set('If-None-Match', first.headers.etag);
    expectNotModified(res);
    expect(res.headers.etag).toBe(first.headers.etag);
    expect(res.headers['last-modified']).toBe(first.headers['last-modified']);
  });

  test('a list of ETags that includes the current one → 304, empty body', async () => {
    const { etag } = (await request(app).get('/provinces/PV-01')).headers;
    expectNotModified(await request(app).get('/provinces/PV-01').set('If-None-Match', `"aaaa", ${etag}, "bbbb"`));
  });

  test('the weak form W/"…" of the current ETag → 304, empty body (weak comparison for GET)', async () => {
    const { etag } = (await request(app).get('/provinces/PV-01')).headers;
    expectNotModified(await request(app).get('/provinces/PV-01').set('If-None-Match', `W/${etag}`));
  });

  test('"*" → 304, empty body', async () => {
    expectNotModified(await request(app).get('/provinces/PV-01').set('If-None-Match', '*'));
  });

  test('a different ETag → 200 with the full body', async () => {
    const res = await request(app).get('/provinces/PV-01').set('If-None-Match', '"0000000000000000000000000000000000000000"');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ province_id: 'PV-01', name: 'Western' });
  });

  test('HEAD with the current ETag → 304, empty body', async () => {
    const { etag } = (await request(app).get('/installations/INS-0001')).headers;
    expectNotModified(await request(app).head('/installations/INS-0001').set('If-None-Match', etag));
  });
});

describe('If-Modified-Since → 304 with an empty body', () => {
  test.each(RESOURCES)('%s with its own Last-Modified → 304, empty body', async (path) => {
    const first = await request(app).get(path);
    expectNotModified(await request(app).get(path).set('If-Modified-Since', first.headers['last-modified']));
  });

  test('a later date → 304, empty body', async () => {
    expectNotModified(await request(app).get('/installations/INS-0001').set('If-Modified-Since', 'Fri, 01 Jan 2100 00:00:00 GMT'));
  });

  test('an earlier date → 200 with the full body', async () => {
    const res = await request(app).get('/installations/INS-0001').set('If-Modified-Since', 'Thu, 01 Jan 2015 00:00:00 GMT');
    expect(res.status).toBe(200);
    expect(res.body.installation_id).toBe('INS-0001');
  });

  test('an unparseable date is ignored → 200', async () => {
    expect((await request(app).get('/provinces').set('If-Modified-Since', 'not a date')).status).toBe(200);
  });

  test('If-None-Match wins: a non-matching ETag means 200 even with a future If-Modified-Since', async () => {
    const res = await request(app)
      .get('/provinces/PV-01')
      .set('If-None-Match', '"0000000000000000000000000000000000000000"')
      .set('If-Modified-Since', 'Fri, 01 Jan 2100 00:00:00 GMT');
    expect(res.status).toBe(200);
  });
});

describe('the validators follow the data', () => {
  afterAll(loadTestSeed);

  test('after a new reading, the composite has a new ETag and Last-Modified, and the old ETag gets 200', async () => {
    const before = await request(app).get('/installations/INS-0001');
    const posted = await request(app)
      .post('/installations/INS-0001/readings')
      .send({ timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1020.1, voltage: 230.1 });
    expect(posted.status).toBe(201);

    const after = await request(app).get('/installations/INS-0001');
    expect(after.headers.etag).not.toBe(before.headers.etag);
    // Last-Modified is the new reading's arrival (whole seconds).
    expect(after.headers['last-modified']).toBe(new Date(posted.body.received_at).toUTCString());

    const stale = await request(app).get('/installations/INS-0001').set('If-None-Match', before.headers.etag);
    expect(stale.status).toBe(200);
    expect(stale.body.last_reading.reading_id).toBe(posted.body.reading_id);
  });

  test('each page has its own ETag', async () => {
    const page1 = await request(app).get('/installations?page-size=2');
    const page2 = await request(app).get('/installations?page=2&page-size=2');
    expect(page1.headers.etag).not.toBe(page2.headers.etag);
  });

  test('a collection\'s Last-Modified is the newest change among the members returned', async () => {
    const res = await request(app).get('/installations/INS-0001/readings?page-size=1');
    expect(res.headers['last-modified']).toBe(new Date(res.body.results[0].received_at).toUTCString());
  });
});

describe('what never gets an ETag', () => {
  test('error responses: no ETag or Last-Modified, and Cache-Control: no-store', async () => {
    for (const [method, path] of [['get', '/provinces/PV-99'], ['get', '/districts?province-id=bad'], ['get', '/no-such-route'], ['delete', '/installations/INS-0001/readings']]) {
      const res = await request(app)[method](path);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.etag).toBeUndefined();
      expect(res.headers['last-modified']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  test('an error never turns into a 304, even with If-None-Match: *', async () => {
    const res = await request(app).get('/provinces/PV-99').set('If-None-Match', '*');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROVINCE_NOT_FOUND');
  });

  test('/health is always checked live: no ETag, never a 304', async () => {
    const res = await request(app).get('/health').set('If-None-Match', '*');
    expect(res.status).not.toBe(304);
    expect(res.headers.etag).toBeUndefined();
  });

  test('no weak (W/) ETag anywhere: Express\'s automatic ETag is off', async () => {
    for (const path of ['/provinces', '/installations/INS-0001/readings', '/no-such-route']) {
      const res = await request(app).get(path);
      expect(res.headers.etag || '').not.toMatch(/^W\//);
    }
  });
});
