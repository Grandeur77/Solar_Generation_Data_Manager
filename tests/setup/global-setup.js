const { MongoMemoryServer } = require('mongodb-memory-server');

// One throwaway MongoDB for the whole test run. Each test worker uses its own database on it
// (see tests/helpers/test-db.js), so test files running in parallel never see each other's data.
module.exports = async function globalSetup() {
  const mongod = await MongoMemoryServer.create();
  globalThis.__MONGOD__ = mongod;
  // Workers start after this runs, so they inherit the variable.
  process.env.TEST_MONGODB_BASE_URI = mongod.getUri();
};
