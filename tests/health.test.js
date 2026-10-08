const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const app = require('../src/app');

// A throwaway in-memory MongoDB, so tests never touch Atlas or need a real password.
let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
}, 120000); // the first run downloads a MongoDB binary

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('GET /health', () => {
  // Runs first on purpose: with no URI, db.js rejects without caching anything,
  // so the next test can still open a connection.
  test('returns 503 with the standard error body when the database is not configured', async () => {
    delete process.env.MONGODB_URI;
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.any(String),
      details: [],
      more_info: '/api-docs#error-codes',
    });
    quiet.mockRestore();
  });

  test('returns 200 with the database connected', async () => {
    process.env.MONGODB_URI = mongod.getUri('solar_test');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });
});
