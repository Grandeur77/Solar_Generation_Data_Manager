const request = require('supertest');
const app = require('../src/app');
const { jurisdictionFilter } = require('../src/utils/jurisdiction');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const asAdmin = require('./helpers/authed-request');
const GenerationReading = require('../src/models/generation-reading');

// Fixture hierarchy (tests/fixtures/test-seed.js):
//   PV-01 Western → DT-01 Colombo → SS-001 → INS-0001, INS-0002, INS-0005
//                 → DT-02 Gampaha → SS-002 → INS-0003
//   PV-02 Central → DT-04 Kandy   → SS-003 → INS-0004
// Users: national (USR-001), Western province (USR-002), Central province (USR-003),
//        Colombo district (USR-004), Gampaha district (USR-005).
const USERS = {
  national: ['national@test.example', 'test-national-pass'],
  western: ['western@test.example', 'test-western-pass'],
  central: ['central@test.example', 'test-central-pass'],
  colombo: ['colombo@test.example', 'test-colombo-pass'],
  gampaha: ['gampaha@test.example', 'test-gampaha-pass'],
};
const tokens = {};

beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
  for (const [who, [email, password]] of Object.entries(USERS)) {
    const res = await request(app).post('/auth/tokens').send({ email, password });
    tokens[who] = res.body.access_token;
  }
});
afterAll(tearDownTestDatabase);

const get = (who, path) => request(app).get(path).set('Authorization', `Bearer ${tokens[who]}`);
const ids = (res, field) => (Array.isArray(res.body) ? res.body : res.body.results).map((x) => x[field]);
function expectOutside(res, noun, field, location) {
  expectErrorBody(res, 403, 'OUTSIDE_JURISDICTION');
  expect(res.body.message).toBe(`This ${noun} is outside your jurisdiction.`);
  expect(res.body.details).toEqual([{ field, location, issue: 'Outside your jurisdiction.', reference: null }]);
}

describe('jurisdictionFilter(token)', () => {
  test('national → no restriction; province → province_id; district → district_id', () => {
    expect(jurisdictionFilter({ jurisdiction: { level: 'national', id: null } })).toEqual({});
    expect(jurisdictionFilter({ jurisdiction: { level: 'province', id: 'PV-01' } })).toEqual({ province_id: 'PV-01' });
    expect(jurisdictionFilter({ jurisdiction: { level: 'district', id: 'DT-01' } })).toEqual({ district_id: 'DT-01' });
  });

  test('fails closed: no jurisdiction or an unknown level throws instead of meaning "everything"', () => {
    for (const auth of [undefined, {}, { jurisdiction: null }, { jurisdiction: { level: 'planet', id: 'X' } }]) {
      expect(() => jurisdictionFilter(auth)).toThrow();
    }
  });
});

describe('collections with no filter: each caller silently gets only their own jurisdiction', () => {
  test.each([
    ['national', ['PV-01', 'PV-02']],
    ['western', ['PV-01']],
    ['colombo', []], // a district user sees no whole province (data-model §5)
  ])('/provinces as %s', async (who, expected) => {
    expect(ids(await get(who, '/provinces'), 'province_id')).toEqual(expected);
  });

  test.each([
    ['national', ['DT-01', 'DT-02', 'DT-04']],
    ['western', ['DT-01', 'DT-02']],
    ['central', ['DT-04']],
    ['colombo', ['DT-01']],
  ])('/districts as %s', async (who, expected) => {
    expect(ids(await get(who, '/districts'), 'district_id')).toEqual(expected);
  });

  test.each([
    ['western', ['SS-001', 'SS-002']],
    ['central', ['SS-003']],
    ['colombo', ['SS-001']],
  ])('/grid-substations as %s', async (who, expected) => {
    expect(ids(await get(who, '/grid-substations'), 'substation_id')).toEqual(expected);
  });

  test.each([
    ['national', ['INS-0001', 'INS-0002', 'INS-0003', 'INS-0004', 'INS-0005']],
    ['western', ['INS-0001', 'INS-0002', 'INS-0003', 'INS-0005']],
    ['central', ['INS-0004']],
    ['colombo', ['INS-0001', 'INS-0002', 'INS-0005']],
    ['gampaha', ['INS-0003']],
  ])('/installations as %s, and count is the jurisdiction\'s total', async (who, expected) => {
    const res = await get(who, '/installations');
    expect(ids(res, 'installation_id')).toEqual(expected);
    expect(res.body.count).toBe(expected.length);
  });

  test('pagination counts and links stay inside the jurisdiction', async () => {
    const res = await get('colombo', '/installations?page-size=2');
    expect(res.body.count).toBe(3);
    expect(ids(res, 'installation_id')).toEqual(['INS-0001', 'INS-0002']);
    expect(ids(await get('colombo', res.body.next), 'installation_id')).toEqual(['INS-0005']);
  });

  test('different callers get different bodies, so different ETags, for the same URL', async () => {
    expect((await get('colombo', '/installations')).headers.etag).not.toBe((await get('western', '/installations')).headers.etag);
  });
});

describe('a filter inside (or overlapping) the jurisdiction is applied', () => {
  test.each([
    ['western', '/installations?district-id=DT-02', ['INS-0003']],
    ['western', '/installations?substation-id=SS-001', ['INS-0001', 'INS-0002', 'INS-0005']],
    ['colombo', '/installations?substation-id=SS-001', ['INS-0001', 'INS-0002', 'INS-0005']],
    ['colombo', '/installations?province-id=PV-01', ['INS-0001', 'INS-0002', 'INS-0005']], // own province narrows to own district
    ['colombo', '/installations?district-id=DT-01&status=active', ['INS-0001', 'INS-0002', 'INS-0005']],
  ])('%s: %s', async (who, path, expected) => {
    const res = await get(who, path);
    expect(res.status).toBe(200);
    expect(ids(res, 'installation_id')).toEqual(expected);
  });

  test('districts and substations filtered by an overlapping province', async () => {
    expect(ids(await get('western', '/districts?province-id=PV-01'), 'district_id')).toEqual(['DT-01', 'DT-02']);
    expect(ids(await get('colombo', '/districts?province-id=PV-01'), 'district_id')).toEqual(['DT-01']);
    expect(ids(await get('colombo', '/grid-substations?province-id=PV-01'), 'substation_id')).toEqual(['SS-001']);
    expect(ids(await get('western', '/grid-substations?district-id=DT-02'), 'substation_id')).toEqual(['SS-002']);
  });

  test('an id that does not exist matches nothing: 200 and empty, not 403', async () => {
    expect((await get('western', '/installations?province-id=PV-09')).body.count).toBe(0);
    expect((await get('colombo', '/installations?district-id=DT-99')).body.count).toBe(0);
    expect((await get('colombo', '/districts?province-id=PV-09')).body).toEqual([]);
  });
});

describe('a filter outside the jurisdiction → 403 OUTSIDE_JURISDICTION, never an empty list', () => {
  test.each([
    ['western', '/installations?province-id=PV-02', 'province', 'province-id'],
    ['western', '/districts?province-id=PV-02', 'province', 'province-id'],
    ['western', '/grid-substations?province-id=PV-02', 'province', 'province-id'],
    ['western', '/installations?district-id=DT-04', 'district', 'district-id'],
    ['central', '/installations?district-id=DT-01', 'district', 'district-id'],
    ['colombo', '/installations?district-id=DT-02', 'district', 'district-id'],
    ['colombo', '/installations?province-id=PV-02', 'province', 'province-id'],
    ['colombo', '/installations?substation-id=SS-002', 'grid substation', 'substation-id'],
    ['colombo', '/grid-substations?district-id=DT-02', 'district', 'district-id'],
    ['gampaha', '/districts?province-id=PV-02', 'province', 'province-id'],
  ])('%s: %s', async (who, path, noun, field) => {
    expectOutside(await get(who, path), noun, field, 'query');
  });

  test('a malformed filter is still 400 (its format is checked before its jurisdiction)', async () => {
    expectErrorBody(await get('colombo', '/installations?district-id=Colombo'), 400, 'INVALID_QUERY_PARAMETER');
  });
});

describe('members outside the jurisdiction → 403; missing → 404 first', () => {
  test.each([
    ['western', '/provinces/PV-02', 'province', 'province-id'],
    ['colombo', '/provinces/PV-01', 'province', 'province-id'], // not even their own province
    ['western', '/districts/DT-04', 'district', 'district-id'],
    ['colombo', '/districts/DT-02', 'district', 'district-id'],
    ['colombo', '/grid-substations/SS-002', 'grid substation', 'substation-id'],
    ['central', '/grid-substations/SS-001', 'grid substation', 'substation-id'],
    ['colombo', '/installations/INS-0003', 'installation', 'installation-id'],
    ['colombo', '/installations/INS-0003/last-known-reading', 'installation', 'installation-id'],
    ['colombo', '/installations/INS-0003/readings', 'installation', 'installation-id'],
    ['colombo', '/installations/INS-0003/readings/000000000000000000000009', 'installation', 'installation-id'],
    ['central', '/installations/INS-0001', 'installation', 'installation-id'],
    ['gampaha', '/installations/INS-0001/readings', 'installation', 'installation-id'],
  ])('%s: GET %s', async (who, path, noun, field) => {
    expectOutside(await get(who, path), noun, field, 'path');
  });

  test.each([
    ['western', '/provinces/PV-01'],
    ['colombo', '/districts/DT-01'],
    ['colombo', '/grid-substations/SS-001'],
    ['colombo', '/installations/INS-0001'],
    ['colombo', '/installations/INS-0001/last-known-reading'],
    ['colombo', '/installations/INS-0001/readings'],
    ['western', '/installations/INS-0003/readings/000000000000000000000009'],
  ])('inside: %s GET %s → 200', async (who, path) => {
    expect((await get(who, path)).status).toBe(200);
  });

  test('a missing member is 404 before the jurisdiction is considered', async () => {
    expectErrorBody(await get('colombo', '/installations/INS-9999'), 404, 'INSTALLATION_NOT_FOUND');
    expectErrorBody(await get('colombo', '/districts/DT-99'), 404, 'DISTRICT_NOT_FOUND');
    expectErrorBody(await get('colombo', '/provinces/PV-09'), 404, 'PROVINCE_NOT_FOUND');
  });

  test('403 comes before 400: a bad query on an outside installation is still 403', async () => {
    expectOutside(await get('colombo', '/installations/INS-0003/readings?page-size=0'), 'installation', 'installation-id', 'path');
  });
});

describe('both summaries', () => {
  test('a district user: own district 200 (same figures as national), any other district 403', async () => {
    const own = await get('colombo', '/districts/DT-01/generation-summary?date=2026-10-06');
    const national = await get('national', '/districts/DT-01/generation-summary?date=2026-10-06');
    expect(own.status).toBe(200);
    expect(own.body).toEqual(national.body);
    expect(own.body).toMatchObject({ total_power_kw: 1.5, day_energy_kwh: 30 });
    expectOutside(await get('colombo', '/districts/DT-02/generation-summary?date=2026-10-06'), 'district', 'district-id', 'path');
  });

  test('a province user: districts in their province 200, others 403', async () => {
    expect((await get('western', '/districts/DT-02/generation-summary?date=2026-10-06')).body).toMatchObject({ day_energy_kwh: 2.75 });
    expectOutside(await get('western', '/districts/DT-04/generation-summary'), 'district', 'district-id', 'path');
  });

  test('province summary: own province 200 (same as national); a district user or another province 403', async () => {
    const own = await get('western', '/provinces/PV-01/generation-summary?date=2026-10-06');
    expect(own.body).toEqual((await get('national', '/provinces/PV-01/generation-summary?date=2026-10-06')).body);
    expect(own.body).toMatchObject({ total_power_kw: 4.5, day_energy_kwh: 32.75, installation_count: 4 });
    expectOutside(await get('central', '/provinces/PV-01/generation-summary'), 'province', 'province-id', 'path');
    expectOutside(await get('colombo', '/provinces/PV-01/generation-summary'), 'province', 'province-id', 'path');
  });

  test('403 comes before the date check', async () => {
    expectOutside(await get('colombo', '/districts/DT-02/generation-summary?date=nonsense'), 'district', 'district-id', 'path');
  });
});

describe('the filter is merged into the queries themselves (defence in depth)', () => {
  afterAll(loadTestSeed);

  // The route already checks the district is inside the caller's jurisdiction, so with consistent
  // data the merged filter removes nothing. It matters when a record's copied ids disagree (a
  // damaged or hand-loaded reading): a province user's figures still use only readings tagged
  // with their own province.
  test('summary pipelines: a reading tagged with another province never counts for a province user', async () => {
    await GenerationReading.collection.insertOne({
      _id: '0000000000000000000000d1', installation_id: 'INS-0001', timestamp: new Date('2026-10-06T12:45:00Z'),
      power_kw: 4, energy_kwh: 1050, voltage: 230, received_at: new Date(),
      substation_id: 'SS-001', district_id: 'DT-01', province_id: 'PV-02', // inconsistent on purpose
    });
    const western = await get('western', '/districts/DT-01/generation-summary?date=2026-10-06');
    expect(western.body).toMatchObject({ total_power_kw: 1.5, day_energy_kwh: 30 }); // the bad reading is left out
    const national = await get('national', '/districts/DT-01/generation-summary?date=2026-10-06');
    expect(national.body.total_power_kw).not.toBe(1.5); // national has no province restriction, so it is counted
    await GenerationReading.deleteOne({ _id: '0000000000000000000000d1' });
  });

  // INS-0002 moves from SS-001 (Colombo) to SS-002 (Gampaha). Its old readings keep the district
  // they were sent from (DT-01). Gampaha can now open the installation, but the readings query
  // itself is cut to DT-02, so Colombo's history of that site never reaches a Gampaha user.
  test('a moved installation: the new district sees the site but not readings sent from the old district', async () => {
    const moved = await asAdmin(app).put('/installations/INS-0002').send({
      name: 'Kolonnawa test rooftop 2', meter_id: 'MTR-000002', substation_id: 'SS-002', capacity_kw: 3, status: 'active',
      commissioned_at: '2024-01-15T00:00:00Z', address: 'No. 2, Test Road, Kolonnawa', latitude: 6.9, longitude: 79.9,
    });
    expect(moved.status).toBe(200);

    const composite = await get('gampaha', '/installations/INS-0002');
    expect(composite.status).toBe(200);
    expect(composite.body.last_reading).toBeNull();
    expect((await get('gampaha', '/installations/INS-0002/readings')).body.count).toBe(0);
    expectErrorBody(await get('gampaha', '/installations/INS-0002/last-known-reading'), 404, 'NO_READINGS_YET');
    expectErrorBody(await get('gampaha', '/installations/INS-0002/readings/000000000000000000000008'), 404, 'READING_NOT_FOUND');

    // Colombo can no longer open the installation at all; national still sees all 3 readings.
    expectOutside(await get('colombo', '/installations/INS-0002'), 'installation', 'installation-id', 'path');
    expect((await get('national', '/installations/INS-0002/readings')).body.count).toBe(3);
  });
});
