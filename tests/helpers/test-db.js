const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connectToDatabase } = require('../../src/config/db');
const Province = require('../../src/models/province');
const District = require('../../src/models/district');
const GridSubstation = require('../../src/models/grid-substation');
const SolarInstallation = require('../../src/models/solar-installation');
const GenerationReading = require('../../src/models/generation-reading');
const User = require('../../src/models/user');
const seed = require('../fixtures/test-seed');

const MODELS = [Province, District, GridSubstation, SolarInstallation, GenerationReading, User];
// bcrypt's minimum cost: these hashes only need to work, not resist attack, and tests stay fast.
const TEST_BCRYPT_ROUNDS = 4;

// The fixture uses the API's id names; MongoDB stores the id as _id.
const toDocs = (records, idField) => records.map(({ [idField]: _id, ...rest }) => ({ _id, ...rest }));

// This worker's own database on the shared in-memory server.
function testDatabaseUri() {
  const base = process.env.TEST_MONGODB_BASE_URI;
  if (!base) throw new Error('TEST_MONGODB_BASE_URI is not set; run the tests with npm test');
  return `${base.replace(/\/?$/, '/')}solar_test_${process.env.JEST_WORKER_ID || '1'}`;
}

// Wipes this worker's database and loads the fixture, with the same indexes as production.
async function loadTestSeed() {
  for (const Model of MODELS) {
    await Model.deleteMany({});
    await Model.createIndexes();
  }

  await Province.insertMany(toDocs(seed.provinces, 'province_id'));
  await District.insertMany(toDocs(seed.districts, 'district_id'));
  await GridSubstation.insertMany(toDocs(seed.substations, 'substation_id'));
  await SolarInstallation.insertMany(
    await Promise.all(
      toDocs(seed.installations, 'installation_id').map(async (doc) => ({
        ...doc,
        device_secret_hash: await bcrypt.hash(seed.deviceSecrets[doc._id], TEST_BCRYPT_ROUNDS),
      }))
    )
  );
  await GenerationReading.insertMany(toDocs(seed.readings, 'reading_id'));
  await User.insertMany(
    await Promise.all(
      toDocs(seed.users, 'user_id').map(async ({ password, ...user }) => ({
        ...user,
        password_hash: await bcrypt.hash(password, TEST_BCRYPT_ROUNDS),
      }))
    )
  );
}

// Points the app at this worker's database, connects through the app's own connection module,
// and loads the fixture. Call in beforeAll.
async function setUpTestDatabase() {
  process.env.MONGODB_URI = testDatabaseUri();
  await connectToDatabase();
  await loadTestSeed();
}

// Call in afterAll.
async function tearDownTestDatabase() {
  await mongoose.disconnect();
}

module.exports = { testDatabaseUri, setUpTestDatabase, loadTestSeed, tearDownTestDatabase, seed };
