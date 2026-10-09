const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');

// Leakage suite (Step 9.7). For every read endpoint, a user must receive nothing from outside
// their jurisdiction: not in a body, not in a Location or Link header, not as a 304, not as a
// HEAD that answers 200. The test data (tests/fixtures/test-seed.js):
//   PV-01 Western → DT-01 Colombo → SS-001 → INS-0001, INS-0002, INS-0005
//                 → DT-02 Gampaha → SS-002 → INS-0003
//   PV-02 Central → DT-04 Kandy   → SS-003 → INS-0004
//
// Every identifier of an area is a "marker": if any marker of the other area appears anywhere in a
// response the viewer receives, that is a leak.
const AREAS = {
  'DT-01': {
    credentials: ['colombo@test.example', 'test-colombo-pass'],
    province: 'PV-01', district: 'DT-01', substation: 'SS-001', installation: 'INS-0001', reading: '000000000000000000000005',
    markers: ['DT-01', 'SS-001', 'INS-0001', 'INS-0002', 'INS-0005', 'MTR-000001', 'MTR-000002', 'MTR-000005', 'Colombo', 'Kolonnawa',
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `00000000000000000000000${n}`)],
  },
  'DT-02': {
    credentials: ['gampaha@test.example', 'test-gampaha-pass'],
    province: 'PV-01', district: 'DT-02', substation: 'SS-002', installation: 'INS-0003', reading: '000000000000000000000009',
    markers: ['DT-02', 'SS-002', 'INS-0003', 'MTR-000003', 'Gampaha', '000000000000000000000009', '00000000000000000000000a'],
  },
  'PV-01': {
    credentials: ['western@test.example', 'test-western-pass'],
    province: 'PV-01', district: 'DT-01', substation: 'SS-001', installation: 'INS-0001', reading: '000000000000000000000005',
    markers: ['PV-01', 'Western', 'DT-01', 'DT-02', 'SS-001', 'SS-002', 'INS-0001', 'INS-0002', 'INS-0003', 'INS-0005', 'Colombo', 'Gampaha'],
  },
  'PV-02': {
    credentials: ['central@test.example', 'test-central-pass'],
    province: 'PV-02', district: 'DT-04', substation: 'SS-003', installation: 'INS-0004', reading: '00000000000000000000000b',
    markers: ['PV-02', 'Central', 'DT-04', 'SS-003', 'INS-0004', 'MTR-000004', 'Kandy', '00000000000000000000000b'],
  },
};

// Viewer → the area whose data they must never see. Both directions for each pair.
const PAIRS = [
  ['DT-01', 'DT-02', 'district'],
  ['DT-02', 'DT-01', 'district'],
  ['PV-01', 'PV-02', 'province'],
  ['PV-02', 'PV-01', 'province'],
];

// Every request a viewer makes against the other area, as [label, path]. Each label starts with the
// endpoint's template, so the coverage test below can check that every GET in the spec is here.
function requestsAgainst(own, other) {
  const o = AREAS[other];
  const m = AREAS[own];
  return [
    ['/provinces', '/provinces'],
    ['/provinces/{province-id}', `/provinces/${o.province}`],
    ['/provinces/{province-id}/generation-summary', `/provinces/${o.province}/generation-summary?date=2026-10-06`],
    ['/provinces/{province-id}/generation-summary', `/provinces/${o.province}/generation-summary?date=2026-10-02`],
    ['/districts', '/districts'],
    ['/districts', `/districts?province-id=${o.province}`],
    ['/districts/{district-id}', `/districts/${o.district}`],
    ['/districts/{district-id}/generation-summary', `/districts/${o.district}/generation-summary?date=2026-10-06`],
    ['/districts/{district-id}/generation-summary', `/districts/${o.district}/generation-summary?date=2026-10-02`],
    ['/grid-substations', '/grid-substations'],
    ['/grid-substations', `/grid-substations?province-id=${o.province}`],
    ['/grid-substations', `/grid-substations?district-id=${o.district}`],
    ['/grid-substations/{substation-id}', `/grid-substations/${o.substation}`],
    ['/installations', '/installations'],
    ['/installations', '/installations?status=active'],
    ['/installations', '/installations?status=inactive'],
    ['/installations', '/installations?sort=-capacity_kw'],
    ['/installations', `/installations?province-id=${o.province}`],
    ['/installations', `/installations?district-id=${o.district}`],
    ['/installations', `/installations?substation-id=${o.substation}`],
    ['/installations/{installation-id}', `/installations/${o.installation}`],
    ['/installations/{installation-id}/last-known-reading', `/installations/${o.installation}/last-known-reading`],
    ['/installations/{installation-id}/readings', `/installations/${o.installation}/readings`],
    ['/installations/{installation-id}/readings', `/installations/${o.installation}/readings?from=2026-10-01T00:00:00Z&sort=-power_kw`],
    ['/installations/{installation-id}/readings/{reading-id}', `/installations/${o.installation}/readings/${o.reading}`],
    // The other area's reading id under the viewer's own installation (scope check on the reading).
    ['/installations/{installation-id}/readings/{reading-id}', `/installations/${m.installation}/readings/${o.reading}`],
  ];
}

const tokens = {};
beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
  for (const [area, { credentials: [email, password] }] of Object.entries(AREAS)) {
    tokens[area] = (await request(app).post('/auth/tokens').send({ email, password })).body.access_token;
  }
});
afterAll(tearDownTestDatabase);

const get = (viewer, url) => request(app).get(url).set('Authorization', `Bearer ${tokens[viewer]}`);

// Everything the viewer receives that could carry data: the body and the headers that hold URLs.
const received = (res) => [res.text || '', res.headers.location || '', res.headers.link || ''].join('\n');

// An identifier the viewer typed into their own URL may be repeated back (e.g. "no reading with id
// …"); that tells them nothing new. Anything else of the other area's is a leak. Whether such an
// echo could still reveal existence is checked separately (the "no existence oracle" test).
function expectNoMarkers(res, other, url) {
  const text = received(res);
  const found = AREAS[other].markers.filter((marker) => text.includes(marker) && !url.includes(marker));
  // The URL is in the message, so a failure says exactly which request leaked what.
  expect({ url, status: res.status, leaked: found }).toEqual({ url, status: res.status, leaked: [] });
}

// For a collection page, follow next until the last page, so no page escapes the check.
async function allPages(viewer, first) {
  const pages = [first];
  let next = first.body && first.body.next;
  while (next) {
    const page = await get(viewer, next);
    pages.push(page);
    next = page.body.next;
  }
  return pages;
}

describe.each(PAIRS)('%s user never receives %s data (%s level)', (viewer, other) => {
  test.each(requestsAgainst(viewer, other))('%s: GET %s', async (_, url) => {
    const res = await get(viewer, url);
    // Allowed outcomes: 200 with only the viewer's own data, 403 (outside), or 404. Never a 5xx.
    expect([200, 403, 404]).toContain(res.status);
    expectNoMarkers(res, other, url);
  });

  test('every page of /installations, in small pages, stays inside', async () => {
    for (const page of await allPages(viewer, await get(viewer, '/installations?page-size=1'))) {
      expectNoMarkers(page, other, page.req.path);
    }
  });

  test('HEAD on the other area\'s members is 403, so not even the size of the body is revealed', async () => {
    const o = AREAS[other];
    for (const url of [`/installations/${o.installation}`, `/districts/${o.district}`, `/grid-substations/${o.substation}`]) {
      const res = await request(app).head(url).set('Authorization', `Bearer ${tokens[viewer]}`);
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
  });

  test('no existence oracle: the other area\'s reading id under my installation answers exactly like an id that exists nowhere', async () => {
    const mine = AREAS[viewer].installation;
    const real = await get(viewer, `/installations/${mine}/readings/${AREAS[other].reading}`);
    const never = await get(viewer, `/installations/${mine}/readings/ffffffffffffffffffffffff`);
    expect(real.status).toBe(404);
    expect(real.status).toBe(never.status);
    expect(real.body.message.replace(AREAS[other].reading, 'ID')).toBe(never.body.message.replace('ffffffffffffffffffffffff', 'ID'));
    expect({ ...real.body, message: null }).toEqual({ ...never.body, message: null });
  });

  test('conditional requests never confirm the other area\'s data with a 304', async () => {
    const o = AREAS[other];
    // If-None-Match: * would be a 304 on anything that exists; outside members stay 403.
    for (const url of [`/installations/${o.installation}`, `/installations/${o.installation}/readings`]) {
      const res = await get(viewer, url).set('If-None-Match', '*');
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
    // The other area's ETag for the same collection URL does not match the viewer's version.
    const theirs = await get(other, '/installations');
    const mine = await get(viewer, '/installations').set('If-None-Match', theirs.headers.etag);
    expect(mine.status).toBe(200);
    expectNoMarkers(mine, other, '/installations (their ETag)');
  });
});

describe('figures: a summary only adds up the viewer\'s own area', () => {
  // A marker scan can't see numbers, so the totals are checked against hand-computed values that
  // include only the viewer's area (from the Step 8.1 and 8.4 tables).
  test('Colombo (DT-01) on 6 Oct: 1.5 kW / 30 kWh / 3 installations, without Gampaha\'s 3 kW and 2.75 kWh', async () => {
    expect((await get('DT-01', '/districts/DT-01/generation-summary?date=2026-10-06')).body).toMatchObject({
      total_power_kw: 1.5, day_energy_kwh: 30, installation_count: 3, installed_capacity_kw: 10, reporting_installations: 2,
    });
  });

  test('Gampaha (DT-02) on 6 Oct: 3 kW / 2.75 kWh / 1 installation, without Colombo\'s', async () => {
    expect((await get('DT-02', '/districts/DT-02/generation-summary?date=2026-10-06')).body).toMatchObject({
      total_power_kw: 3, day_energy_kwh: 2.75, installation_count: 1, installed_capacity_kw: 4,
    });
  });

  test('Western (PV-01) on 2 Oct, the only day Kandy reported: 0 kW, 4 installations, no Kandy 6 kW or 10 kW capacity', async () => {
    expect((await get('PV-01', '/provinces/PV-01/generation-summary?date=2026-10-02')).body).toMatchObject({
      total_power_kw: 0, peak_power_kw: 0, installation_count: 4, installed_capacity_kw: 14, reporting_installations: 0,
    });
  });

  test('Central (PV-02) on 6 Oct: nothing reported, 1 installation, none of Western\'s 4.5 kW or 32.75 kWh', async () => {
    expect((await get('PV-02', '/provinces/PV-02/generation-summary?date=2026-10-06')).body).toMatchObject({
      total_power_kw: 0, day_energy_kwh: 0, installation_count: 1, installed_capacity_kw: 10, reporting_installations: 0,
    });
  });

  test('collection counts are the viewer\'s own totals', async () => {
    expect((await get('DT-01', '/installations')).body.count).toBe(3);
    expect((await get('DT-02', '/installations')).body.count).toBe(1);
    expect((await get('PV-01', '/installations')).body.count).toBe(4);
    expect((await get('PV-02', '/installations')).body.count).toBe(1);
  });
});

describe('coverage: every read endpoint in the API is in this suite', () => {
  const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
  // Every GET in the contract except the public ones (no data to leak).
  const PUBLIC = ['/health'];
  const specReads = Object.keys(spec.paths).filter((p) => spec.paths[p].get && !PUBLIC.includes(p)).sort();
  const covered = [...new Set(PAIRS.flatMap(([viewer, other]) => requestsAgainst(viewer, other).map(([template]) => template)))].sort();

  test('the suite covers exactly the GET endpoints of openapi.yaml (a new endpoint fails this until it is added)', () => {
    expect(covered).toEqual(specReads);
  });

  test('the endpoints covered', () => {
    // Listed here so the report can cite them; must match the spec (previous test).
    expect(covered).toEqual([
      '/districts',
      '/districts/{district-id}',
      '/districts/{district-id}/generation-summary',
      '/grid-substations',
      '/grid-substations/{substation-id}',
      '/installations',
      '/installations/{installation-id}',
      '/installations/{installation-id}/last-known-reading',
      '/installations/{installation-id}/readings',
      '/installations/{installation-id}/readings/{reading-id}',
      '/provinces',
      '/provinces/{province-id}',
      '/provinces/{province-id}/generation-summary',
    ]);
  });
});
