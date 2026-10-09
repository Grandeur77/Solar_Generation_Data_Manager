// A low limit for this file only, set before the app (and its limiter) is loaded.
process.env.AUTH_TOKEN_MAX_FAILURES = '3';

const request = require('supertest');
const app = require('../src/app');
const { setUpTestDatabase, loadTestSeed, tearDownTestDatabase } = require('./helpers/test-db');
const { expectErrorBody } = require('./helpers/expect-error');
const { adminToken } = require('./helpers/authed-request');

beforeAll(async () => {
  await setUpTestDatabase();
  await loadTestSeed();
});
afterAll(tearDownTestDatabase);

const signIn = (body) => request(app).post('/auth/tokens').send(body);
const GOOD = { email: 'national@test.example', password: 'test-national-pass' };
const WRONG = { email: 'national@test.example', password: 'wrong-password' };

// One sequence, because every request here comes from the same address and shares one counter.
test('POST /auth/tokens: failed attempts are limited (429 + Retry-After); successes never count', async () => {
  // 1. Successful sign-ins don't count, however many there are.
  for (let i = 0; i < 5; i++) expect((await signIn(GOOD)).status).toBe(201);

  // 2. Three failures are allowed (a wrong password, an inactive account, a malformed body).
  expect((await signIn(WRONG)).status).toBe(401);
  expect((await signIn({ email: 'kandy@test.example', password: 'test-kandy-pass' })).status).toBe(403);
  expect((await signIn({ email: 'national@test.example' })).status).toBe(400);

  // 3. The next attempt is refused before anything is checked: 429 with the standard body.
  const locked = await signIn(WRONG);
  expectErrorBody(locked, 429, 'TOO_MANY_REQUESTS');
  expect(locked.headers['cache-control']).toBe('no-store');
  const retryAfter = Number(locked.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  expect(locked.body.message).toBe(`Too many failed attempts. Try again in ${retryAfter} seconds.`);

  // 4. While locked out, even the right password and a malformed body get 429 (no guessing continues).
  expectErrorBody(await signIn(GOOD), 429, 'TOO_MANY_REQUESTS');
  expectErrorBody(await request(app).post('/auth/tokens').type('text').send('x'), 429, 'TOO_MANY_REQUESTS');

  // 5. Only sign-in is limited: an existing token still works on the rest of the API.
  expect((await request(app).get('/provinces').set('Authorization', `Bearer ${adminToken()}`)).status).toBe(200);
});
