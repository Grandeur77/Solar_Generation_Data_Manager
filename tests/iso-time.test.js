const request = require('supertest');
const app = require('../src/app');
const { parseInstant } = require('../src/utils/iso-time');
const { setUpTestDatabase, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');

beforeAll(setUpTestDatabase);
afterAll(tearDownTestDatabase);

describe('parseInstant()', () => {
  test.each([
    ['2026-10-06T04:30:00Z', '2026-10-06T04:30:00.000Z'],
    ['2026-10-06T10:00:00+05:30', '2026-10-06T04:30:00.000Z'],
    ['2026-10-06T04:30Z', '2026-10-06T04:30:00.000Z'],
    ['2026-10-06T04:30:00.250Z', '2026-10-06T04:30:00.250Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'], // a real leap day
  ])('accepts %s', (text, iso) => {
    expect(parseInstant(text).toISOString()).toBe(iso);
  });

  test.each([
    '2026-02-30T00:00:00Z', // JavaScript would silently turn this into 2 March
    '2026-02-29T00:00:00Z', // 2026 is not a leap year
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-10-06T24:00:00Z',
    '2026-10-06T23:60:00Z',
    '2026-10-06T23:59:60Z',
    '2026-10-06T04:30:00', // no time zone
    '2026-10-06', // a date only
    'yesterday',
    '',
  ])('refuses %s', (text) => {
    expect(parseInstant(text)).toBeNull();
  });
});

describe('impossible dates are refused everywhere a date-time is accepted', () => {
  test('a reading timestamp on 30 February → 400 (it was silently stored as 2 March before)', async () => {
    const res = await request(app)
      .post('/installations/INS-0005/readings')
      .send({ timestamp: '2026-02-30T06:00:00Z', power_kw: 1, energy_kwh: 1, voltage: 230 });
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details.map((d) => d.field)).toEqual(['timestamp']);
  });

  test('a time-window bound on 30 February → 400', async () => {
    expectErrorBody(await request(app).get('/installations/INS-0001/readings?from=2026-02-30T00:00:00Z'), 400, 'INVALID_QUERY_PARAMETER');
  });
});
