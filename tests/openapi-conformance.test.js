const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { adminToken, deviceToken } = require('./helpers/authed-request');

// openapi.yaml against the real API: every response the API sends must be documented for that
// operation (status, headers) and match its schema, with no field the schema doesn't mention.
// A change to the code that the spec doesn't follow (or the reverse) fails here.
const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
const deref = (o) => (o && o.$ref ? o.$ref.split('/').slice(1).reduce((a, k) => a[k], spec) : o);

// A small checker for the OpenAPI 3.0 schema features this spec uses.
function validate(schema, value, at, problems) {
  const s = deref(schema);
  if (!s) return;
  if (s.oneOf) {
    const matches = s.oneOf.some((option) => {
      const p = [];
      validate(option, value, at, p);
      return p.length === 0;
    });
    if (!matches) problems.push(`${at}: matches none of oneOf`);
    return;
  }
  if (value === null) {
    if (!s.nullable) problems.push(`${at}: null, but not nullable`);
    return;
  }
  const is = {
    object: value !== null && typeof value === 'object' && !Array.isArray(value),
    array: Array.isArray(value),
    string: typeof value === 'string',
    integer: Number.isInteger(value),
    number: typeof value === 'number',
    boolean: typeof value === 'boolean',
  };
  if (s.type && !is[s.type]) return problems.push(`${at}: expected ${s.type}, got ${JSON.stringify(value)}`);
  if (s.enum && !s.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${s.enum.join(', ')}`);
  if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) problems.push(`${at}: not a date-time`);
  if (s.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`${at}: not a date`);
  if (s.pattern && !new RegExp(s.pattern).test(value)) problems.push(`${at}: "${value}" does not match ${s.pattern}`);
  if (s.type === 'array' && s.items) value.forEach((item, i) => validate(s.items, item, `${at}[${i}]`, problems));
  if (s.properties) {
    for (const field of s.required || []) if (!(field in value)) problems.push(`${at}: missing required ${field}`);
    for (const [field, fieldSchema] of Object.entries(s.properties)) if (field in value) validate(fieldSchema, value[field], `${at}.${field}`, problems);
    for (const field of Object.keys(value)) if (!(field in s.properties)) problems.push(`${at}: field ${field} is not in the schema`);
  }
  return undefined;
}

function operationFor(method, url) {
  const p = url.split('?')[0];
  for (const [template, item] of Object.entries(spec.paths)) {
    if (new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(p)) return { template, operation: item[method] };
  }
  return { template: null, operation: null };
}

// Headers whose presence the spec must document when the API sends them.
const TRACKED_HEADERS = ['etag', 'last-modified', 'location', 'allow', 'retry-after', 'www-authenticate', 'cache-control', 'vary', 'x-request-id'];

async function send([method, url, token, body, headers = {}]) {
  let req = request(app)[method](url);
  const bearer = typeof token === 'function' ? token() : token;
  if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  if (body === 'text') return req.type('text').send('x');
  return body === undefined ? req : req.send(body);
}

function problemsWith(method, url, res) {
  const { template, operation } = operationFor(method, url);
  if (!operation) return [`${method.toUpperCase()} ${template || url} is not in the spec`];
  const documented = deref(operation.responses[String(res.status)]);
  if (!documented) return [`status ${res.status} is not documented for ${method.toUpperCase()} ${template}`];
  const problems = [];
  const schema = documented.content && documented.content['application/json'] && documented.content['application/json'].schema;
  if (res.status !== 304 && res.text) {
    if (schema) validate(schema, res.body, 'body', problems);
    else problems.push('a body is sent but no schema is documented');
  }
  const documentedHeaders = Object.keys(documented.headers || {}).map((h) => h.toLowerCase());
  for (const h of TRACKED_HEADERS) if (res.headers[h] && !documentedHeaders.includes(h)) problems.push(`header ${h} is sent but not documented`);
  return problems;
}

const A = () => adminToken();
const D = (id) => () => deviceToken(id);
const NEW_INSTALLATION = {
  installation_id: 'INS-0006', name: 'Kolonnawa test rooftop 6', meter_id: 'MTR-000006', substation_id: 'SS-001', capacity_kw: 5,
  status: 'active', commissioned_at: '2026-10-01T00:00:00Z', address: 'No. 6, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
};
const { installation_id: _unused, ...REPLACEMENT } = { ...NEW_INSTALLATION, name: 'Renamed' };
const READING = { timestamp: '2026-10-06T12:45:00Z', power_kw: 0.3, energy_kwh: 1021, voltage: 230 };

// [method, url, token, body, headers]. In order: later writes depend on earlier ones.
const REQUESTS = [
  ['get', '/health'], ['get', '/health', null, undefined, { Accept: 'text/html' }], ['get', '/health?a.b=1'],
  ['post', '/auth/tokens', null, { email: 'national@test.example', password: 'test-national-pass' }],
  ['post', '/auth/tokens', null, { meter_id: 'MTR-000001', device_secret: 'test-device-secret-INS-0001' }],
  ['post', '/auth/tokens', null, { email: 'national@test.example', password: 'wrong' }],
  ['post', '/auth/tokens', null, { email: 'kandy@test.example', password: 'test-kandy-pass' }],
  ['post', '/auth/tokens', null, {}], ['post', '/auth/tokens', null, 'text'],
  ['get', '/auth/tokens'], ['put', '/auth/tokens'], ['patch', '/auth/tokens'], ['delete', '/auth/tokens'],
  ['get', '/provinces', A], ['get', '/provinces'], ['get', '/provinces', 'not-a-token'], ['get', '/provinces', D('INS-0001')],
  ['get', '/provinces?a.b=1', A], ['get', '/provinces', A, undefined, { Accept: 'text/html' }],
  ['get', '/provinces/PV-01', A], ['get', '/provinces/PV-99', A],
  ['get', '/provinces/PV-01/generation-summary?date=2026-10-06', A], ['get', '/provinces/PV-01/generation-summary?date=x', A],
  ['post', '/provinces/PV-01/generation-summary', A], ['delete', '/provinces/PV-01/generation-summary', A],
  ['get', '/districts', A], ['get', '/districts?province-id=PV-01', A], ['get', '/districts?province-id=bad', A],
  ['get', '/districts/DT-01', A], ['get', '/districts/DT-99', A],
  ['get', '/districts/DT-01/generation-summary?date=2026-10-05', A], ['get', '/districts/DT-04/generation-summary?date=2026-10-06', A],
  ['put', '/districts/DT-01/generation-summary', A],
  ['get', '/grid-substations', A], ['get', '/grid-substations?district-id=DT-01', A], ['get', '/grid-substations/SS-001', A], ['get', '/grid-substations/SS-999', A],
  ['get', '/installations', A], ['get', '/installations?page=2&page-size=2&sort=-capacity_kw&status=active', A],
  ['get', '/installations?sort=bogus', A], ['get', '/installations?page-size=101', A],
  ['get', '/installations/INS-0001', A], ['get', '/installations/INS-0005', A], ['get', '/installations/INS-9999', A],
  ['get', '/installations/INS-0001/last-known-reading', A], ['get', '/installations/INS-0005/last-known-reading', A],
  ['get', '/installations/INS-0001/readings?page-size=2&sort=-power_kw&min-power-kw=1', A],
  ['get', '/installations/INS-0001/readings?from=2026-10-06T10:00:00Z&to=2026-10-06T00:00:00Z', A],
  ['get', '/installations/INS-0001/readings/000000000000000000000005', A], ['get', '/installations/INS-0001/readings/ffffffffffffffffffffffff', A],
  ['post', '/installations/INS-0001/readings', D('INS-0001'), READING],
  ['post', '/installations/INS-0001/readings', D('INS-0001'), READING],
  ['post', '/installations/INS-0001/readings', D('INS-0001'), { ...READING, timestamp: '2026-10-06T13:00:00Z', power_kw: 99 }],
  ['post', '/installations/INS-0001/readings', D('INS-0001'), 'text'],
  ['post', '/installations/INS-0002/readings', D('INS-0001'), {}], ['post', '/installations/INS-0004/readings', D('INS-0004'), {}],
  ['post', '/installations/INS-0001/readings', A, READING],
  ['put', '/installations/INS-0001/readings', A], ['patch', '/installations/INS-0001/readings', A], ['delete', '/installations/INS-0001/readings', A],
  ['put', '/installations/INS-0001/readings/000000000000000000000005', A], ['delete', '/installations/INS-0001/readings/000000000000000000000005', A],
  ['post', '/installations', A, NEW_INSTALLATION], ['post', '/installations', A, NEW_INSTALLATION], ['post', '/installations', A, { name: 'x' }],
  ['post', '/installations', A, 'text'], ['post', '/installations', () => deviceToken('INS-0001'), NEW_INSTALLATION],
  ['put', '/installations/INS-0006', A, { ...REPLACEMENT, meter_id: 'MTR-000006' }, { 'If-Match': '"stale"' }],
  ['put', '/installations/INS-0006', A, { ...REPLACEMENT, meter_id: 'MTR-000006' }], ['put', '/installations/INS-0006', A, REPLACEMENT],
  ['put', '/installations/INS-9999', A, REPLACEMENT],
  ['patch', '/installations/INS-0006', A, {}], ['delete', '/installations/INS-0006', A, undefined, { 'If-Match': '"stale"' }],
  ['delete', '/installations/INS-0006', A], ['delete', '/installations/INS-0006', A],
];

beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
});
afterAll(tearDownTestDatabase);

test('every response is documented for its operation, with its status, headers and schema', async () => {
  const failures = [];
  const statuses = new Set();
  for (const r of REQUESTS) {
    const res = await send(r);
    statuses.add(res.status);
    const problems = problemsWith(r[0], r[1], res);
    if (problems.length) failures.push(`${res.status} ${r[0].toUpperCase()} ${r[1]}: ${problems.join(' | ')}`);
  }
  expect(failures).toEqual([]);
  // The requests above really do exercise every status the brief and the rubric ask about.
  for (const status of [200, 201, 400, 401, 403, 404, 405, 406, 409, 412, 415]) expect(statuses).toContain(status);
});

test('304: the conditional GET response is documented', async () => {
  const first = await request(app).get('/installations/INS-0001').set('Authorization', `Bearer ${adminToken()}`);
  const res = await request(app).get('/installations/INS-0001').set('Authorization', `Bearer ${adminToken()}`).set('If-None-Match', first.headers.etag);
  expect(res.status).toBe(304);
  expect(problemsWith('get', '/installations/INS-0001', res)).toEqual([]);
});

test('every operation in the spec exists in the API (none is documented but missing)', async () => {
  const sample = { 'province-id': 'PV-01', 'district-id': 'DT-01', 'substation-id': 'SS-001', 'installation-id': 'INS-0001', 'reading-id': '000000000000000000000005' };
  const missing = [];
  for (const [template, item] of Object.entries(spec.paths)) {
    const url = template.replace(/\{([^}]+)\}/g, (_, name) => sample[name]);
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      const res = await request(app)[method](url).set('Authorization', `Bearer ${adminToken()}`).send({});
      // A documented operation never falls through to "no such route".
      if (res.body && res.body.code === 'ROUTE_NOT_FOUND') missing.push(`${method.toUpperCase()} ${template}`);
    }
  }
  expect(missing).toEqual([]);
});

describe('examples', () => {
  test('every request body, query parameter and schema field has an example', () => {
    const gaps = [];
    for (const [template, item] of Object.entries(spec.paths)) {
      for (const method of ['post', 'put']) {
        const body = item[method] && deref(item[method].requestBody);
        if (body && !body.content['application/json'].example && !body.content['application/json'].examples) gaps.push(`${method.toUpperCase()} ${template} body`);
      }
    }
    for (const [name, p] of Object.entries(spec.components.parameters)) {
      if (p.in === 'query' && p.example === undefined && (p.schema || {}).example === undefined) gaps.push(`parameter ${name}`);
    }
    for (const [name, s] of Object.entries(spec.components.schemas)) {
      for (const [field, f] of Object.entries(s.properties || {})) {
        const d = deref(f);
        if (d.example === undefined && !d.enum && d.type !== 'object' && d.type !== 'array' && !d.properties && !f.$ref) gaps.push(`${name}.${field}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  test('every shared error response has a complete example of the error body', () => {
    const gaps = [];
    for (const [name, r] of Object.entries(spec.components.responses)) {
      const c = r.content && r.content['application/json'];
      if (!c) continue;
      if (!c.example) gaps.push(`${name}: no example`);
      else {
        const problems = [];
        validate(c.schema, c.example, name, problems);
        gaps.push(...problems);
      }
    }
    expect(gaps).toEqual([]);
  });
});
