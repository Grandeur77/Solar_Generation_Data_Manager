const request = require('supertest');
const app = require('../src/app');
const SolarInstallation = require('../src/models/solar-installation');
const GridSubstation = require('../src/models/grid-substation');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase, seed } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture: PV-01 Western -> DT-01 Colombo (SS-001: INS-0001, INS-0002, INS-0005)
//                        -> DT-02 Gampaha (SS-002: INS-0003)
//          PV-02 Central -> DT-04 Kandy   (SS-003: INS-0004, inactive)
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const ids = (res, field) => res.body.map((item) => item[field]);
const get = (path) => request(app).get(path);

// The plain atomic shape, exactly: the fixture record with commissioned_at as stored (ISO with ms).
const expectedInstallation = (id) => {
  const record = seed.installations.find((i) => i.installation_id === id);
  return { ...record, commissioned_at: new Date(record.commissioned_at).toISOString() };
};

describe('GET /grid-substations', () => {
  test('returns every substation with its parent district_id, in id order', async () => {
    const res = await get('/grid-substations');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual([
      { substation_id: 'SS-001', name: 'Kolonnawa Grid Substation', district_id: 'DT-01' },
      { substation_id: 'SS-002', name: 'Gampaha Grid Substation', district_id: 'DT-02' },
      { substation_id: 'SS-003', name: 'Kandy Grid Substation', district_id: 'DT-04' },
    ]);
  });

  test.each([
    ['district-id=DT-01', ['SS-001']],
    ['district-id=DT-02', ['SS-002']],
    ['province-id=PV-01', ['SS-001', 'SS-002']],
    ['province-id=PV-02', ['SS-003']],
    ['province-id=PV-01&district-id=DT-02', ['SS-002']],
  ])('?%s → %j', async (query, expected) => {
    const res = await get(`/grid-substations?${query}`);
    expect(res.status).toBe(200);
    expect(ids(res, 'substation_id')).toEqual(expected);
  });

  test.each([
    ['a district outside the province', 'province-id=PV-02&district-id=DT-01'],
    ['a well-formed but unknown province', 'province-id=PV-77'],
    ['a well-formed but unknown district', 'district-id=DT-99'],
  ])('%s → 200 []', async (label, query) => {
    const res = await get(`/grid-substations?${query}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test.each(['province-id=western', 'district-id=colombo', 'district-id=DT-1'])('malformed ?%s → 400', async (query) => {
    const res = await get(`/grid-substations?${query}`);
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details[0]).toMatchObject({ field: query.split('=')[0], location: 'query' });
  });
});

describe('GET /grid-substations/{substation-id}', () => {
  test('returns the substation', async () => {
    const res = await get('/grid-substations/SS-002');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ substation_id: 'SS-002', name: 'Gampaha Grid Substation', district_id: 'DT-02' });
  });

  test('unknown id → 404 SUBSTATION_NOT_FOUND', async () => {
    expectErrorBody(await get('/grid-substations/SS-999'), 404, 'SUBSTATION_NOT_FOUND');
  });
});

describe('GET /installations', () => {
  test('returns every installation, inactive ones included, in id order', async () => {
    const res = await get('/installations');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(ids(res, 'installation_id')).toEqual(['INS-0001', 'INS-0002', 'INS-0003', 'INS-0004', 'INS-0005']);
  });

  test('items use the plain atomic shape: no last_reading, no secret hash, no change times', async () => {
    const res = await get('/installations');
    expect(res.body[0]).toEqual(expectedInstallation('INS-0001'));
    for (const item of res.body) {
      expect(item).not.toHaveProperty('last_reading');
      expect(item).not.toHaveProperty('device_secret_hash');
      expect(item).not.toHaveProperty('created_at');
      expect(item).not.toHaveProperty('_id');
    }
  });

  test.each([
    ['province-id=PV-01', ['INS-0001', 'INS-0002', 'INS-0003', 'INS-0005']],
    ['province-id=PV-02', ['INS-0004']],
    ['district-id=DT-01', ['INS-0001', 'INS-0002', 'INS-0005']],
    ['district-id=DT-02', ['INS-0003']],
    ['substation-id=SS-001', ['INS-0001', 'INS-0002', 'INS-0005']],
    ['substation-id=SS-002', ['INS-0003']],
    ['province-id=PV-01&district-id=DT-01&substation-id=SS-001', ['INS-0001', 'INS-0002', 'INS-0005']],
  ])('?%s → %j', async (query, expected) => {
    const res = await get(`/installations?${query}`);
    expect(res.status).toBe(200);
    expect(ids(res, 'installation_id')).toEqual(expected);
  });

  test.each([
    ['a substation outside the district', 'district-id=DT-02&substation-id=SS-001'],
    ['a district outside the province', 'province-id=PV-02&district-id=DT-01'],
    ['a well-formed but unknown substation', 'substation-id=SS-999'],
  ])('%s → 200 []', async (label, query) => {
    const res = await get(`/installations?${query}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test.each(['province-id=PV1', 'district-id=DT-001', 'substation-id=SS-01', 'substation-id=SS-001&substation-id=SS-002'])(
    'malformed or repeated ?%s → 400',
    async (query) => {
      const res = await get(`/installations?${query}`);
      expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
      expect(res.body.details[0]).toMatchObject({ field: query.split('=')[0], location: 'query' });
    }
  );
});

describe('GET /installations/{installation-id}', () => {
  test('returns the plain installation, exactly', async () => {
    const res = await get('/installations/INS-0004');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expectedInstallation('INS-0004'));
  });

  test('unknown id → 404 INSTALLATION_NOT_FOUND', async () => {
    expectErrorBody(await get('/installations/INS-9999'), 404, 'INSTALLATION_NOT_FOUND');
  });
});

describe('empty collections', () => {
  afterAll(loadTestSeed);

  test('no substations and no installations → 200 [] for both', async () => {
    await SolarInstallation.deleteMany({});
    await GridSubstation.deleteMany({});
    for (const path of ['/grid-substations', '/installations']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });
});
