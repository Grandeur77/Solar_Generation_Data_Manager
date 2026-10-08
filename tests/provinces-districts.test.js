const request = require('supertest');
const app = require('../src/app');
const Province = require('../src/models/province');
const District = require('../src/models/district');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

// Fixture: PV-01 Western (DT-01 Colombo, DT-02 Gampaha), PV-02 Central (DT-04 Kandy).
beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

const expectJson = (res, status) => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
};

describe('GET /provinces', () => {
  test('returns every province as a flat array, in id order', async () => {
    const res = await request(app).get('/provinces');
    expectJson(res, 200);
    expect(res.body).toEqual([
      { province_id: 'PV-01', name: 'Western' },
      { province_id: 'PV-02', name: 'Central' },
    ]);
  });
});

describe('GET /provinces/{province-id}', () => {
  test('returns the province', async () => {
    const res = await request(app).get('/provinces/PV-02');
    expectJson(res, 200);
    expect(res.body).toEqual({ province_id: 'PV-02', name: 'Central' });
  });

  test('unknown id → 404 PROVINCE_NOT_FOUND', async () => {
    const res = await request(app).get('/provinces/PV-99');
    expectErrorBody(res, 404, 'PROVINCE_NOT_FOUND');
    expect(res.body.message).toContain('PV-99');
  });

  test('malformed id → 404, not a server error', async () => {
    const res = await request(app).get('/provinces/not-an-id');
    expectErrorBody(res, 404, 'PROVINCE_NOT_FOUND');
  });
});

describe('GET /districts', () => {
  test('returns every district with its parent province_id', async () => {
    const res = await request(app).get('/districts');
    expectJson(res, 200);
    expect(res.body).toEqual([
      { district_id: 'DT-01', name: 'Colombo', province_id: 'PV-01' },
      { district_id: 'DT-02', name: 'Gampaha', province_id: 'PV-01' },
      { district_id: 'DT-04', name: 'Kandy', province_id: 'PV-02' },
    ]);
  });

  test('?province-id=PV-01 returns only that province\'s districts', async () => {
    const res = await request(app).get('/districts?province-id=PV-01');
    expectJson(res, 200);
    expect(res.body.map((d) => d.district_id)).toEqual(['DT-01', 'DT-02']);
  });

  test('?province-id=PV-02 returns only Kandy', async () => {
    const res = await request(app).get('/districts?province-id=PV-02');
    expect(res.body.map((d) => d.district_id)).toEqual(['DT-04']);
  });

  test('a well-formed province id with no districts → 200 []', async () => {
    const res = await request(app).get('/districts?province-id=PV-77');
    expectJson(res, 200);
    expect(res.body).toEqual([]);
  });

  test('a malformed province-id → 400 INVALID_QUERY_PARAMETER naming the parameter', async () => {
    const res = await request(app).get('/districts?province-id=western');
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
    expect(res.body.details).toEqual([
      { field: 'province-id', location: 'query', issue: expect.any(String), reference: null },
    ]);
  });

  test('province-id given twice → 400', async () => {
    const res = await request(app).get('/districts?province-id=PV-01&province-id=PV-02');
    expectErrorBody(res, 400, 'INVALID_QUERY_PARAMETER');
  });
});

describe('GET /districts/{district-id}', () => {
  test('returns the district', async () => {
    const res = await request(app).get('/districts/DT-02');
    expectJson(res, 200);
    expect(res.body).toEqual({ district_id: 'DT-02', name: 'Gampaha', province_id: 'PV-01' });
  });

  test('unknown id → 404 DISTRICT_NOT_FOUND', async () => {
    const res = await request(app).get('/districts/DT-99');
    expectErrorBody(res, 404, 'DISTRICT_NOT_FOUND');
  });
});

describe('empty collections', () => {
  afterAll(loadTestSeed); // put the fixture back for any later tests in this file

  test('no provinces and no districts → 200 [] for both, never 404', async () => {
    await District.deleteMany({});
    await Province.deleteMany({});

    const provinces = await request(app).get('/provinces');
    expectJson(provinces, 200);
    expect(provinces.body).toEqual([]);

    const districts = await request(app).get('/districts');
    expectJson(districts, 200);
    expect(districts.body).toEqual([]);
  });
});

describe('content negotiation still applies', () => {
  test('Accept: text/html on /provinces → 406', async () => {
    const res = await request(app).get('/provinces').set('Accept', 'text/html');
    expectErrorBody(res, 406, 'NOT_ACCEPTABLE');
  });
});
