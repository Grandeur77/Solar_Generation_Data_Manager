// Checks the seeded database and prints a summary table. Read-only: it never changes anything.
//   npm run verify-seed
// Exit code 0 when every check passes, 1 otherwise, so it can gate a deployment or CI step.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const { connectToDatabase } = require('../src/config/db');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

const results = [];
function record(check, expected, actual, pass) {
  results.push({ check, expected: String(expected), actual: String(actual), pass });
}

// Ids in `values` that are not in `known`, as "none" or a short list.
function missing(values, known) {
  const unknown = [...new Set(values)].filter((v) => !known.has(v));
  return unknown.length === 0 ? 'none' : unknown.slice(0, 5).join(', ') + (unknown.length > 5 ? ` (+${unknown.length - 5})` : '');
}

async function main() {
  const connection = await connectToDatabase();
  const db = connection.db;
  console.log(`Verifying ${connection.host} / database "${connection.name}"\n`);

  const provinces = await db.collection('provinces').find({}, { projection: { _id: 1 } }).toArray();
  const districts = await db.collection('districts').find({}, { projection: { province_id: 1 } }).toArray();
  const substations = await db.collection('grid_substations').find({}, { projection: { district_id: 1 } }).toArray();
  const installations = await db
    .collection('installations')
    .find({}, { projection: { substation_id: 1, district_id: 1, province_id: 1, status: 1 } })
    .toArray();
  const users = await db.collection('users').find({}, { projection: { province_id: 1, district_id: 1, role: 1 } }).toArray();
  const readings = db.collection('generation_readings');

  const provinceIds = new Set(provinces.map((p) => p._id));
  const districtById = new Map(districts.map((d) => [d._id, d]));
  const substationById = new Map(substations.map((s) => [s._id, s]));
  const installationById = new Map(installations.map((i) => [i._id, i]));

  // Per installation: how many readings, the time span, and which jurisdiction copies they carry.
  const perInstallation = await readings
    .aggregate([
      {
        $group: {
          _id: '$installation_id',
          count: { $sum: 1 },
          first: { $min: '$timestamp' },
          last: { $max: '$timestamp' },
          substation_ids: { $addToSet: '$substation_id' },
          district_ids: { $addToSet: '$district_id' },
          province_ids: { $addToSet: '$province_id' },
        },
      },
    ])
    .toArray();
  const readingCount = perInstallation.reduce((sum, i) => sum + i.count, 0);

  // ---- Counts against the brief's seed scale ----
  record('Provinces', '= 9', provinces.length, provinces.length === 9);
  record('Districts', '= 25', districts.length, districts.length === 25);
  record('Grid substations', '>= 20', substations.length, substations.length >= 20);
  record('Installations', '>= 200', installations.length, installations.length >= 200);
  record('Generation readings', '> 0', readingCount, readingCount > 0);

  // "1 week or more per installation": every active site that reports covers at least 7 days.
  // Inactive sites stopped reporting part-way through, so they are not held to the week.
  const shortActive = perInstallation.filter((r) => {
    const status = installationById.get(r._id)?.status;
    return status === 'active' && r.last - r.first < WEEK_MS - INTERVAL_MS;
  });
  const activeReporting = perInstallation.filter((r) => installationById.get(r._id)?.status === 'active').length;
  record('Active installations with >= 1 week of readings', `all ${activeReporting}`, activeReporting - shortActive.length, shortActive.length === 0);

  const reporting = new Set(perInstallation.map((r) => r._id));
  const silent = installations.filter((i) => !reporting.has(i._id)).map((i) => i._id);
  record('Installations with no readings (on purpose)', '1 to 3', `${silent.length} (${silent.join(', ') || 'none'})`, silent.length >= 1 && silent.length <= 3);

  // ---- Every foreign key resolves ----
  record('District -> province', 'none missing', missing(districts.map((d) => d.province_id), provinceIds), districts.every((d) => provinceIds.has(d.province_id)));
  record('Substation -> district', 'none missing', missing(substations.map((s) => s.district_id), districtById), substations.every((s) => districtById.has(s.district_id)));
  record('Installation -> substation', 'none missing', missing(installations.map((i) => i.substation_id), substationById), installations.every((i) => substationById.has(i.substation_id)));

  // An installation's copied district and province must be its substation's real ones.
  const badCopies = installations.filter((i) => {
    const s = substationById.get(i.substation_id);
    return s && (s.district_id !== i.district_id || districtById.get(s.district_id)?.province_id !== i.province_id);
  });
  record('Installation district/province copies match substation', '0 mismatched', badCopies.length, badCopies.length === 0);

  record('Reading -> installation', 'none missing', missing([...reporting], installationById), [...reporting].every((id) => installationById.has(id)));

  // A reading's copied ids must equal its installation's, so jurisdiction filters can't leak.
  const badReadingCopies = perInstallation.filter((r) => {
    const i = installationById.get(r._id);
    if (!i) return false;
    const same = (list, value) => list.length === 1 && list[0] === value;
    return !(same(r.substation_ids, i.substation_id) && same(r.district_ids, i.district_id) && same(r.province_ids, i.province_id));
  });
  record('Reading jurisdiction copies match installation', '0 installations wrong', badReadingCopies.length, badReadingCopies.length === 0);

  const userProvinces = users.filter((u) => u.province_id).map((u) => u.province_id);
  const userDistricts = users.filter((u) => u.district_id).map((u) => u.district_id);
  record('User -> province / district', 'none missing', [missing(userProvinces, provinceIds), missing(userDistricts, districtById)].filter((m) => m !== 'none').join(', ') || 'none', userProvinces.every((p) => provinceIds.has(p)) && userDistricts.every((d) => districtById.has(d)));

  // ---- Time-series integrity ----
  const [duplicates] = await readings
    .aggregate([
      { $group: { _id: { installation_id: '$installation_id', timestamp: '$timestamp' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'n' },
    ])
    .toArray();
  record('Duplicate installation + timestamp', '0', duplicates?.n ?? 0, !duplicates);

  // Compare each reading with the previous one of the same installation, in time order, inside the database.
  const [decreases] = await readings
    .aggregate([
      {
        $setWindowFields: {
          partitionBy: '$installation_id',
          sortBy: { timestamp: 1 },
          output: { previous_energy: { $shift: { output: '$energy_kwh', by: -1 } } },
        },
      },
      { $match: { $expr: { $lt: ['$energy_kwh', '$previous_energy'] } } },
      { $count: 'n' },
    ])
    .toArray();
  record('energy_kwh decreases (per installation)', '0', decreases?.n ?? 0, !decreases);

  printTable();
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  if (failed > 0) process.exitCode = 1;
}

function printTable() {
  const headers = { check: 'Check', expected: 'Expected', actual: 'Actual', result: 'Result' };
  const rows = results.map((r) => ({ ...r, result: r.pass ? 'PASS' : 'FAIL' }));
  const width = (key) => Math.max(headers[key].length, ...rows.map((r) => r[key].length));
  const keys = ['check', 'expected', 'actual', 'result'];
  const line = (row) => keys.map((k) => row[k].padEnd(width(k))).join('  ');
  console.log(line(headers));
  console.log(keys.map((k) => '-'.repeat(width(k))).join('  '));
  rows.forEach((row) => console.log(line(row)));
}

main()
  .catch((err) => {
    console.error('verify-seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
