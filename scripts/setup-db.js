// Builds every index declared on the models. Run once per database, and again after an index is added:
//   npm run setup-db
// Safe to re-run: existing indexes are left alone, and nothing is ever dropped.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const { connectToDatabase } = require('../src/config/db');

const models = [
  require('../src/models/province'),
  require('../src/models/district'),
  require('../src/models/grid-substation'),
  require('../src/models/solar-installation'),
  require('../src/models/generation-reading'),
  require('../src/models/user'),
];

async function main() {
  const connection = await connectToDatabase();
  // Show which database is being changed, never the credentials.
  console.log(`Building indexes on ${connection.host} / database "${connection.name}"\n`);

  for (const model of models) {
    // Create the collection first: one with only the default _id index would not exist yet.
    await model.createCollection();
    await model.createIndexes();
    const indexes = await model.collection.indexes();
    const names = indexes.map((index) => (index.unique ? `${index.name} (unique)` : index.name));
    console.log(`${model.collection.collectionName.padEnd(20)} ${names.join(', ')}`);
  }
  console.log('\nAll indexes are in place.');
}

main()
  .catch((err) => {
    // A unique index cannot be built while duplicates exist; the message names the duplicate key.
    console.error('setup-db failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
