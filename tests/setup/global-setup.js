const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One throwaway MongoDB for the whole test run. Each test worker uses its own database on it
// (see tests/helpers/test-db.js), so test files running in parallel never see each other's data.
module.exports = async function globalSetup() {
  const mongod = await MongoMemoryServer.create();
  globalThis.__MONGOD__ = mongod;
  // Workers start after this runs, so they inherit the variable.
  process.env.TEST_MONGODB_BASE_URI = mongod.getUri();
  // A fresh random signing secret for every run: tests never need (or see) a real one.
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  // Behaviour tests make many failed sign-ins on purpose; the rate limit has its own test file,
  // which sets a low limit before loading the app.
  process.env.AUTH_TOKEN_MAX_FAILURES = '1000';
};
