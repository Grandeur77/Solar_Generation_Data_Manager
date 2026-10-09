// Smoke test against a running deployment: every endpoint, its status codes, headers and response
// shape, plus the seed's scale against the brief. Read-only by default.
//
//   SMOKE_BASE_URL=https://<your-app>.vercel.app npm run smoke
//
// Environment:
//   SMOKE_BASE_URL          required, e.g. https://<your-app>.vercel.app (no trailing slash)
//   SMOKE_CREDENTIALS_FILE  default seed/credentials.json: the file written by the seed run that
//                           loaded the deployed database (never committed). Secrets are read from it
//                           at run time and never printed.
//   SMOKE_WRITE=1           also POST one real reading (201, Location, then a 409 duplicate).
//                           Off by default, because it adds a reading to the live data.
//
// Every 409, 412, 415 and 400 below is provoked with a request the API refuses before changing
// anything, so a normal run leaves the live data exactly as it was. It makes 2 failed sign-ins,
// well under the rate limit (10 per 15 minutes).
const fs = require('fs');
const path = require('path');

const BASE = (process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');
const CREDENTIALS_FILE = process.env.SMOKE_CREDENTIALS_FILE || path.join(__dirname, '..', 'seed', 'credentials.json');
const WRITE = process.env.SMOKE_WRITE === '1';

// The brief's minimum scale (§4) and the seed's deliberately silent installations.
const SCALE = { provinces: 9, districts: 25, substations: 20, installations: 200, readingDays: 7 };
const SILENT = ['INS-0030', 'INS-0105', 'INS-0219'];

const results = [];
const record = (status, name, detail = '') => results.push({ status, name, detail });

// Runs one named check. A thrown Error is a FAIL with its message; a returned string is a WARN.
async function check(name, fn) {
  try {
    const warning = await fn();
    record(warning ? 'WARN' : 'PASS', name, warning || '');
  } catch (err) {
    record('FAIL', name, err.message);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// One HTTP request. The body is parsed as JSON when the response says it is JSON.
async function call(method, urlPath, { token, headers = {}, json, text } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(30000) };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  if (text !== undefined) {
    init.headers['Content-Type'] = 'text/plain';
    init.body = text;
  }
  const res = await fetch(`${BASE}${urlPath}`, init);
  const raw = await res.text();
  const isJson = (res.headers.get('content-type') || '').startsWith('application/json');
  return { status: res.status, headers: res.headers, raw, body: isJson && raw ? JSON.parse(raw) : raw };
}

// Shared assertions.
const STRONG_ETAG = /^"[0-9a-f]{40}"$/;
// Vercel's edge compresses larger GET responses and correctly weakens our ETag to W/"<same hash>".
const SCOPED_GET_ETAG = /^(W\/)?"[0-9a-f]{40}"$/;
function expectStatus(res, status) {
  expect(res.status === status, `expected ${status}, got ${res.status}${res.body && res.body.code ? ` (${res.body.code})` : ''}`);
}
function expectError(res, status, code) {
  expectStatus(res, status);
  const b = res.body;
  expect(b && b.code === code, `expected code ${code}, got ${b && b.code}`);
  expect(typeof b.message === 'string' && Array.isArray(b.details) && b.more_info === '/api-docs#error-codes', 'error body is not { code, message, details, more_info }');
  expect(res.headers.get('cache-control') === 'no-store', 'an error must be Cache-Control: no-store');
  expect(!res.headers.get('etag'), 'an error must not have an ETag');
}
function expectScopedGet(res) {
  expectStatus(res, 200);
  expect(SCOPED_GET_ETAG.test(res.headers.get('etag') || ''), `no strong (or CDN-weakened) ETag (got ${res.headers.get('etag')})`);
  expect(res.headers.get('cache-control') === 'private, no-cache', `Cache-Control is ${res.headers.get('cache-control')}`);
  const vary = res.headers.get('vary') || '';
  expect(/\bAccept\b/.test(vary) && /\bAuthorization\b/.test(vary), `Vary is "${vary}"`);
}
function expectPage(body) {
  expect(body && Number.isInteger(body.count) && Array.isArray(body.results) && 'next' in body && 'previous' in body, 'not a page { count, next, previous, results }');
}
const hasFields = (obj, fields) => fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));

// All pages of a collection, following next (page-size 100, the cap).
async function allItems(urlPath, token) {
  const items = [];
  let next = `${urlPath}${urlPath.includes('?') ? '&' : '?'}page-size=100`;
  while (next) {
    const res = await call('GET', next, { token });
    expectStatus(res, 200);
    items.push(...res.body.results);
    next = res.body.next;
  }
  return items;
}

// Prints every result and exits: 1 if anything failed, 0 otherwise.
function reportAndExit(extraMessage) {
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.detail ? `\n      → ${r.detail}` : ''}`);
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('WARN')} warnings, ${count('FAIL')} failed (${results.length} checks)`);
  if (extraMessage) console.log(`\n${extraMessage}`);
  process.exit(count('FAIL') > 0 || extraMessage ? 1 : 0);
}

async function main() {
  if (!BASE) {
    console.error('Set SMOKE_BASE_URL, e.g. SMOKE_BASE_URL=https://<your-app>.vercel.app npm run smoke');
    process.exit(2);
  }
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error(`No credentials file at ${CREDENTIALS_FILE}. Run the seed, or set SMOKE_CREDENTIALS_FILE.`);
    process.exit(2);
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const user = (id) => credentials.users.find((u) => u.user_id === id);
  const device = (id) => credentials.devices.find((d) => d.installation_id === id);
  const tokens = {};

  console.log(`Smoke test: ${BASE}${WRITE ? ' (with one real write)' : ' (read-only)'}\n`);

  // ── Platform ──────────────────────────────────────────────────────────────────────────────
  await check('HTTPS is used', async () => (BASE.startsWith('https://') ? '' : 'not HTTPS (fine for a local run, not for the deployment)'));

  await check('GET /health → 200 { status: ok, database: connected }, no-store', async () => {
    const res = await call('GET', '/health');
    expectStatus(res, 200);
    expect(res.body.status === 'ok' && res.body.database === 'connected', `body ${res.raw}`);
    expect(res.headers.get('cache-control') === 'no-store', 'health must be no-store');
  });

  await check('security headers (helmet): nosniff, HSTS, CSP, no X-Powered-By', async () => {
    const res = await call('GET', '/health');
    expect(res.headers.get('x-content-type-options') === 'nosniff', 'no nosniff');
    expect(/max-age=\d+/.test(res.headers.get('strict-transport-security') || ''), 'no HSTS');
    expect(/default-src 'self'/.test(res.headers.get('content-security-policy') || ''), 'no CSP');
    expect(!res.headers.get('x-powered-by'), 'X-Powered-By is exposed');
  });

  await check('GET /api-docs/ (HTML), /api-docs/openapi (YAML 3.0.3), /api-docs/init.js', async () => {
    const page = await call('GET', '/api-docs/', { headers: { Accept: 'text/html' } });
    expectStatus(page, 200);
    expect((page.headers.get('content-type') || '').startsWith('text/html'), 'docs page is not HTML');
    const spec = await call('GET', '/api-docs/openapi', { headers: { Accept: '*/*' } });
    expectStatus(spec, 200);
    expect(spec.raw.startsWith('openapi: 3.0.3'), 'spec does not start with openapi: 3.0.3');
    expectStatus(await call('GET', '/api-docs/init.js', { headers: { Accept: '*/*' } }), 200);
  });

  await check('404 ROUTE_NOT_FOUND for a path that is not a resource', async () => {
    expectError(await call('GET', '/no-such-thing'), 404, 'ROUTE_NOT_FOUND');
  });

  // ── Tokens (201, 401, 403) ────────────────────────────────────────────────────────────────
  const signIn = (body) => call('POST', '/auth/tokens', { json: body });
  for (const [label, id] of [['national', 'USR-001'], ['western', 'USR-002'], ['colombo', 'USR-004'], ['admin', 'USR-007']]) {
    await check(`POST /auth/tokens (${label}) → 201, token shape, no-store, no Location`, async () => {
      const u = user(id);
      expect(u, `${id} is not in the credentials file`);
      const res = await signIn({ email: u.email, password: u.password });
      expect(res.status !== 401, 'got 401: is the credentials file from the seed run that loaded this database?');
      expectStatus(res, 201);
      expect(hasFields(res.body, ['access_token', 'token_type', 'expires_in', 'scope']) && res.body.token_type === 'Bearer', 'token body shape');
      expect(res.body.access_token.split('.').length === 3, 'access_token is not a JWT');
      expect(res.headers.get('cache-control') === 'no-store' && !res.headers.get('location'), 'must be no-store without Location');
      expect(res.body.expires_in === (label === 'admin' ? 900 : 3600), `expires_in ${res.body.expires_in}`);
      tokens[label] = res.body.access_token;
    });
  }

  await check('POST /auth/tokens wrong password → 401 INVALID_CREDENTIALS + WWW-Authenticate', async () => {
    const res = await signIn({ email: user('USR-001').email, password: 'definitely-not-the-password' });
    expectError(res, 401, 'INVALID_CREDENTIALS');
    expect((res.headers.get('www-authenticate') || '').startsWith('Bearer realm="slsea-solar-api"'), 'no WWW-Authenticate: Bearer');
  });

  await check('POST /auth/tokens inactive user, right password → 403 ACCOUNT_INACTIVE', async () => {
    const u = user('USR-006');
    expectError(await signIn({ email: u.email, password: u.password }), 403, 'ACCOUNT_INACTIVE');
  });

  // An active installation with readings, from the first page, for device checks and 409.
  let sample;
  await check('choose an active installation with readings for the device checks', async () => {
    expect(tokens.national, 'no national token (see the sign-in checks above)');
    const page = await call('GET', '/installations?status=active&page-size=20', { token: tokens.national });
    expectStatus(page, 200);
    sample = page.body.results.find((i) => !SILENT.includes(i.installation_id));
    expect(sample, 'no active installation found');
  });

  await check('POST /auth/tokens (meter) → 201 installation-write, 24 h', async () => {
    expect(sample, 'no sample installation (see the check above)');
    const d = device(sample.installation_id);
    expect(d, `${sample.installation_id} is not in the credentials file`);
    const res = await signIn({ meter_id: d.meter_id, device_secret: d.device_secret });
    expectStatus(res, 201);
    expect(res.body.scope === 'installation-write' && res.body.expires_in === 86400, `scope ${res.body.scope}, expires_in ${res.body.expires_in}`);
    tokens.device = res.body.access_token;
  });

  // Everything below needs these tokens and the sample installation. Without them each later
  // check would fail for the same reason, so stop here and say why.
  const missing = ['national', 'western', 'colombo', 'admin', 'device'].filter((t) => !tokens[t]);
  if (missing.length > 0 || !sample) {
    reportAndExit(
      `Stopped: could not get ${missing.length ? `tokens for ${missing.join(', ')}` : 'a sample installation'}. ` +
        'Is SMOKE_CREDENTIALS_FILE from the seed run that loaded this database, and is the deployment healthy?'
    );
  }

  await check('401 AUTHENTICATION_REQUIRED without a token, with WWW-Authenticate', async () => {
    const res = await call('GET', '/installations');
    expectError(res, 401, 'AUTHENTICATION_REQUIRED');
    expect(res.headers.get('www-authenticate') === 'Bearer realm="slsea-solar-api"', `WWW-Authenticate: ${res.headers.get('www-authenticate')}`);
  });

  await check('401 INVALID_TOKEN for a tampered token, error="invalid_token"', async () => {
    const res = await call('GET', '/installations', { token: `${tokens.national}x` });
    expectError(res, 401, 'INVALID_TOKEN');
    expect(/error="invalid_token"/.test(res.headers.get('www-authenticate') || ''), 'no error="invalid_token"');
  });

  await check('403 INSUFFICIENT_SCOPE: a meter reading, with error="insufficient_scope"', async () => {
    const res = await call('GET', '/provinces', { token: tokens.device });
    expectError(res, 403, 'INSUFFICIENT_SCOPE');
    expect(/error="insufficient_scope", scope="analyst-read-by-jurisdiction"/.test(res.headers.get('www-authenticate') || ''), 'challenge missing');
  });

  await check('403 INSUFFICIENT_SCOPE: an analyst writing to the registry', async () => {
    expectError(await call('POST', '/installations', { token: tokens.national, json: {} }), 403, 'INSUFFICIENT_SCOPE');
  });

  await check('403 INSTALLATION_MISMATCH: a meter posting to another installation', async () => {
    const other = sample.installation_id === 'INS-0001' ? 'INS-0002' : 'INS-0001';
    expectError(await call('POST', `/installations/${other}/readings`, { token: tokens.device, json: {} }), 403, 'INSTALLATION_MISMATCH');
  });

  // ── Read endpoints: status, headers, shape ───────────────────────────────────────────────
  let provinces;
  let districts;
  let substations;
  let installations;

  await check('GET /provinces → 200 array, private caching, strong ETag', async () => {
    const res = await call('GET', '/provinces', { token: tokens.national });
    expectScopedGet(res);
    expect(Array.isArray(res.body) && res.body.every((p) => hasFields(p, ['province_id', 'name'])), 'shape');
    provinces = res.body;
  });

  await check('GET /provinces/{province-id} → 200 with Last-Modified', async () => {
    const res = await call('GET', '/provinces/PV-01', { token: tokens.national });
    expectScopedGet(res);
    expect(res.body.province_id === 'PV-01' && res.headers.get('last-modified'), 'id or Last-Modified');
  });

  await check('GET /districts and ?province-id= → 200, filter applied', async () => {
    const res = await call('GET', '/districts', { token: tokens.national });
    expectScopedGet(res);
    districts = res.body;
    expect(districts.every((d) => hasFields(d, ['district_id', 'name', 'province_id'])), 'shape');
    const western = await call('GET', '/districts?province-id=PV-01', { token: tokens.national });
    expect(western.body.length > 0 && western.body.every((d) => d.province_id === 'PV-01'), 'filter not applied');
  });

  await check('GET /districts/{district-id} → 200', async () => {
    expectScopedGet(await call('GET', '/districts/DT-01', { token: tokens.national }));
  });

  await check('GET /grid-substations and /grid-substations/{substation-id} → 200', async () => {
    const res = await call('GET', '/grid-substations', { token: tokens.national });
    expectScopedGet(res);
    substations = res.body;
    expect(substations.every((s) => hasFields(s, ['substation_id', 'name', 'district_id'])), 'shape');
    expectScopedGet(await call('GET', `/grid-substations/${substations[0].substation_id}`, { token: tokens.national }));
  });

  await check('GET /installations → page, no Last-Modified, next link works', async () => {
    const res = await call('GET', '/installations?page-size=5', { token: tokens.national });
    expectScopedGet(res);
    expectPage(res.body);
    expect(!res.headers.get('last-modified'), 'a collection must not send Last-Modified');
    expect(res.body.results.length === 5 && res.body.next && res.body.previous === null, 'page 1 of 5');
    const next = await call('GET', res.body.next, { token: tokens.national });
    expect(next.status === 200 && next.body.results[0].installation_id !== res.body.results[0].installation_id, 'next link');
  });

  await check('GET /installations?page-size=101 → 400 (cap is 100)', async () => {
    expectError(await call('GET', '/installations?page-size=101', { token: tokens.national }), 400, 'INVALID_QUERY_PARAMETER');
  });

  await check('GET /installations/{installation-id} → composite with one last_reading', async () => {
    const res = await call('GET', `/installations/${sample.installation_id}`, { token: tokens.national });
    expectScopedGet(res);
    expect(hasFields(res.body, ['installation_id', 'meter_id', 'substation_id', 'district_id', 'province_id', 'capacity_kw', 'status', 'last_reading']), 'shape');
    expect(res.body.last_reading && hasFields(res.body.last_reading, ['reading_id', 'timestamp', 'power_kw', 'energy_kwh', 'voltage', 'received_at']), 'last_reading');
    expect(!('device_secret_hash' in res.body), 'device_secret_hash leaked');
    sample = res.body;
  });

  await check('a silent installation: last_reading null, last-known-reading 404 NO_READINGS_YET', async () => {
    const res = await call('GET', `/installations/${SILENT[0]}`, { token: tokens.national });
    expectStatus(res, 200);
    expect(res.body.last_reading === null, 'last_reading is not null');
    expectError(await call('GET', `/installations/${SILENT[0]}/last-known-reading`, { token: tokens.national }), 404, 'NO_READINGS_YET');
  });

  await check('GET /installations/{installation-id}/last-known-reading → 200, same as last_reading', async () => {
    const res = await call('GET', `/installations/${sample.installation_id}/last-known-reading`, { token: tokens.national });
    expectScopedGet(res);
    expect(res.body.reading_id === sample.last_reading.reading_id, 'not the composite\'s last_reading');
  });

  let firstReading;
  await check('GET /installations/{installation-id}/readings → page, newest first, window and sort', async () => {
    const res = await call('GET', `/installations/${sample.installation_id}/readings?page-size=10`, { token: tokens.national });
    expectScopedGet(res);
    expectPage(res.body);
    const times = res.body.results.map((r) => r.timestamp);
    expect(times.join() === [...times].sort().reverse().join(), 'not newest first');
    firstReading = res.body.results[0];
    const to = new Date(Date.parse(times[0]) - 60 * 60 * 1000).toISOString();
    const windowed = await call('GET', `/installations/${sample.installation_id}/readings?to=${to}&sort=-power_kw&page-size=5`, { token: tokens.national });
    expect(windowed.status === 200 && windowed.body.results.every((r) => r.timestamp < to), 'time window not applied');
  });

  await check('GET /installations/{installation-id}/readings/{reading-id} → 200 with Last-Modified', async () => {
    const res = await call('GET', `/installations/${sample.installation_id}/readings/${firstReading.reading_id}`, { token: tokens.national });
    expectScopedGet(res);
    expect(res.body.reading_id === firstReading.reading_id && res.headers.get('last-modified'), 'reading or Last-Modified');
  });

  const SUMMARY_FIELDS = ['date', 'total_power_kw', 'power_as_of', 'day_energy_kwh', 'peak_power_kw', 'peak_at', 'installed_capacity_kw', 'capacity_utilisation', 'installation_count', 'reporting_installations'];
  let todaySummary;
  await check('GET /districts/{district-id}/generation-summary → 200, all fields, ETag only', async () => {
    const res = await call('GET', `/districts/${sample.district_id}/generation-summary`, { token: tokens.national });
    expectScopedGet(res);
    expect(hasFields(res.body, ['district_id', ...SUMMARY_FIELDS]), 'shape');
    expect(!res.headers.get('last-modified'), 'a summary must not send Last-Modified');
    todaySummary = res.body;
  });

  await check('GET /provinces/{province-id}/generation-summary → 200; ?date= invalid → 400', async () => {
    const res = await call('GET', `/provinces/${sample.province_id}/generation-summary`, { token: tokens.national });
    expectScopedGet(res);
    expect(hasFields(res.body, ['province_id', ...SUMMARY_FIELDS]), 'shape');
    expectError(await call('GET', `/provinces/${sample.province_id}/generation-summary?date=2026-02-30`, { token: tokens.national }), 400, 'INVALID_QUERY_PARAMETER');
  });

  // ── Jurisdiction ─────────────────────────────────────────────────────────────────────────
  await check('district user: /installations only their district; another district → 403', async () => {
    const own = await allItems('/installations', tokens.colombo);
    expect(own.length > 0 && own.every((i) => i.district_id === 'DT-01'), 'Colombo user sees other districts');
    expectError(await call('GET', '/districts/DT-02', { token: tokens.colombo }), 403, 'OUTSIDE_JURISDICTION');
    expectError(await call('GET', '/installations?district-id=DT-02', { token: tokens.colombo }), 403, 'OUTSIDE_JURISDICTION');
  });

  await check('province user: only their province; another province → 403', async () => {
    const res = await call('GET', '/districts', { token: tokens.western });
    expect(res.body.length > 0 && res.body.every((d) => d.province_id === 'PV-01'), 'Western user sees other provinces');
    expectError(await call('GET', '/provinces/PV-02/generation-summary', { token: tokens.western }), 403, 'OUTSIDE_JURISDICTION');
  });

  // ── 304, 404, 405, 406, 409, 412, 415, 400 ───────────────────────────────────────────────
  await check('304 for If-None-Match and for If-Modified-Since, empty body', async () => {
    const url = `/installations/${sample.installation_id}`;
    const first = await call('GET', url, { token: tokens.national });
    const byEtag = await call('GET', url, { token: tokens.national, headers: { 'If-None-Match': first.headers.get('etag') } });
    expectStatus(byEtag, 304);
    expect(byEtag.raw === '' && byEtag.headers.get('etag') === first.headers.get('etag'), '304 must be empty and keep the ETag');
    const byDate = await call('GET', url, { token: tokens.national, headers: { 'If-Modified-Since': first.headers.get('last-modified') } });
    expectStatus(byDate, 304);
  });

  await check('404 INSTALLATION_NOT_FOUND for a missing member', async () => {
    expectError(await call('GET', '/installations/INS-9999', { token: tokens.national }), 404, 'INSTALLATION_NOT_FOUND');
  });

  await check('405 with Allow: PATCH on an installation, DELETE on readings, POST on a summary', async () => {
    const patch = await call('PATCH', `/installations/${sample.installation_id}`, { token: tokens.admin, json: {} });
    expectError(patch, 405, 'METHOD_NOT_ALLOWED');
    expect(patch.headers.get('allow') === 'GET, HEAD, PUT, DELETE', `Allow: ${patch.headers.get('allow')}`);
    const del = await call('DELETE', `/installations/${sample.installation_id}/readings`, { token: tokens.admin });
    expect(del.status === 405 && del.headers.get('allow') === 'GET, HEAD, POST', 'readings DELETE');
    const post = await call('POST', `/districts/${sample.district_id}/generation-summary`, { token: tokens.national });
    expect(post.status === 405 && post.headers.get('allow') === 'GET, HEAD', 'summary POST');
  });

  await check('406 NOT_ACCEPTABLE for Accept: text/html', async () => {
    expectError(await call('GET', '/provinces', { token: tokens.national, headers: { Accept: 'text/html' } }), 406, 'NOT_ACCEPTABLE');
  });

  const registryBody = {
    installation_id: sample.installation_id, name: sample.name, meter_id: sample.meter_id, substation_id: sample.substation_id,
    capacity_kw: sample.capacity_kw, status: sample.status, commissioned_at: sample.commissioned_at, address: sample.address,
    latitude: sample.latitude, longitude: sample.longitude,
  };
  await check('409 INSTALLATION_ID_TAKEN: registering an id that exists (nothing created)', async () => {
    expectError(await call('POST', '/installations', { token: tokens.admin, json: registryBody }), 409, 'INSTALLATION_ID_TAKEN');
  });

  await check('409 READING_DUPLICATE: the latest reading sent again (nothing stored)', async () => {
    const r = sample.last_reading;
    const res = await call('POST', `/installations/${sample.installation_id}/readings`, {
      token: tokens.device,
      json: { timestamp: r.timestamp, power_kw: r.power_kw, energy_kwh: r.energy_kwh, voltage: r.voltage },
    });
    expectError(res, 409, 'READING_DUPLICATE');
    expect(res.body.details[0].reference === `/installations/${sample.installation_id}/readings/${r.reading_id}`, 'reference to the existing reading');
  });

  await check('412 PRECONDITION_FAILED: PUT with a stale If-Match (refused before the body is read)', async () => {
    const { installation_id: _id, ...replacement } = registryBody;
    const res = await call('PUT', `/installations/${sample.installation_id}`, { token: tokens.admin, headers: { 'If-Match': '"0000000000000000000000000000000000000000"' }, json: replacement });
    expectError(res, 412, 'PRECONDITION_FAILED');
  });

  await check('415 UNSUPPORTED_MEDIA_TYPE: a text body', async () => {
    expectError(await call('POST', '/installations', { token: tokens.admin, text: 'not json' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  await check('400 VALIDATION_FAILED: an incomplete installation (nothing created)', async () => {
    const res = await call('POST', '/installations', { token: tokens.admin, json: { name: 'only a name' } });
    expectError(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.length >= 8, 'every missing field should be listed');
  });

  await check('400 VALIDATION_FAILED: a key that could be a MongoDB operator', async () => {
    expectError(await call('POST', '/auth/tokens', { json: { email: { $ne: null }, password: 'x' } }), 400, 'VALIDATION_FAILED');
  });

  // ── Optional real write ──────────────────────────────────────────────────────────────────
  if (WRITE) {
    await check('POST a reading → 201, Location resolves to the same body, ETag; resent → 409', async () => {
      const last = sample.last_reading;
      const reading = { timestamp: new Date().toISOString(), power_kw: 0, energy_kwh: Number((last.energy_kwh + 0.001).toFixed(3)), voltage: 230 };
      const res = await call('POST', `/installations/${sample.installation_id}/readings`, { token: tokens.device, json: reading });
      expectStatus(res, 201);
      const location = res.headers.get('location');
      expect(location && STRONG_ETAG.test(res.headers.get('etag') || '') && res.headers.get('last-modified'), 'Location, ETag, Last-Modified');
      const fetched = await call('GET', location, { token: tokens.national });
      expect(fetched.status === 200 && JSON.stringify(fetched.body) === JSON.stringify(res.body), 'Location does not return the same reading');
      const again = await call('POST', `/installations/${sample.installation_id}/readings`, { token: tokens.device, json: reading });
      expectError(again, 409, 'READING_DUPLICATE');
    });
  }

  // ── Seed scale (brief §4) and integrity ──────────────────────────────────────────────────
  await check(`seed scale: ${SCALE.provinces} provinces, ${SCALE.districts} districts, ≥${SCALE.substations} substations, ≥${SCALE.installations} installations`, async () => {
    installations = await allItems('/installations', tokens.national);
    expect(provinces.length === SCALE.provinces, `${provinces.length} provinces`);
    expect(districts.length === SCALE.districts, `${districts.length} districts`);
    expect(substations.length >= SCALE.substations, `${substations.length} substations`);
    expect(installations.length >= SCALE.installations, `${installations.length} installations`);
  });

  await check('seed integrity: every parent id exists, and installations match their substation', async () => {
    const provinceIds = new Set(provinces.map((p) => p.province_id));
    const districtById = new Map(districts.map((d) => [d.district_id, d]));
    const substationById = new Map(substations.map((s) => [s.substation_id, s]));
    expect(districts.every((d) => provinceIds.has(d.province_id)), 'a district has an unknown province');
    expect(substations.every((s) => districtById.has(s.district_id)), 'a substation has an unknown district');
    for (const i of installations) {
      const s = substationById.get(i.substation_id);
      expect(s, `${i.installation_id} has an unknown substation`);
      expect(i.district_id === s.district_id && i.province_id === districtById.get(s.district_id).province_id, `${i.installation_id} copies the wrong district or province`);
    }
  });

  await check(`seed readings: ≥${SCALE.readingDays} days of history on sampled installations`, async () => {
    const withReadings = installations.filter((i) => !SILENT.includes(i.installation_id));
    const picks = [withReadings[0], withReadings[Math.floor(withReadings.length / 2)], withReadings[withReadings.length - 1]];
    for (const i of picks) {
      const oldest = await call('GET', `/installations/${i.installation_id}/readings?sort=timestamp&page-size=1`, { token: tokens.national });
      const newest = await call('GET', `/installations/${i.installation_id}/readings?page-size=1`, { token: tokens.national });
      expect(oldest.body.count > 0, `${i.installation_id} has no readings`);
      const days = (Date.parse(newest.body.results[0].timestamp) - Date.parse(oldest.body.results[0].timestamp)) / 86400000;
      expect(days >= SCALE.readingDays - 0.25, `${i.installation_id}: only ${days.toFixed(2)} days of readings`);
    }
  });

  await check('seed has installations with no readings (edge case on purpose)', async () => {
    const silent = [];
    for (const id of SILENT) {
      const res = await call('GET', `/installations/${id}`, { token: tokens.national });
      if (res.status === 200 && res.body.last_reading === null) silent.push(id);
    }
    expect(silent.length > 0, 'none of the expected silent installations is silent');
  });

  await check('seed freshness: the latest reading is recent, so "today" has data', async () => {
    const ageHours = (Date.now() - Date.parse(sample.last_reading.timestamp)) / 3600000;
    if (ageHours > 24) return `latest reading is ${ageHours.toFixed(1)} h old: re-seed before submission and the viva (today's summary shows ${todaySummary.day_energy_kwh} kWh)`;
    return '';
  });

  reportAndExit();
}

main().catch((err) => {
  console.error('Smoke test could not run:', err.message);
  process.exit(2);
});
