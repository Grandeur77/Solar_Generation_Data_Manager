// Loads seed/hierarchy.json and generates 8 days of readings ending now.
//   npm run seed -- --yes
// Idempotent: each run deletes the seeded collections and reloads them, so re-running never
// duplicates anything and moves the reading window up to "now" (re-seed before submission and
// the viva so the last-known readings and today's summary are fresh).
// Run scripts/setup-db.js first so the unique installation_id + timestamp index exists.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { connectToDatabase } = require('../src/config/db');
const { makeRandom } = require('./lib/random');
const Province = require('../src/models/province');
const District = require('../src/models/district');
const GridSubstation = require('../src/models/grid-substation');
const SolarInstallation = require('../src/models/solar-installation');
const GenerationReading = require('../src/models/generation-reading');
const User = require('../src/models/user');
const hierarchy = require('../seed/hierarchy.json');

// Plain-text credentials go only to this file, which .gitignore excludes (*credentials*.json).
const CREDENTIALS_FILE = path.join(__dirname, '..', 'seed', 'credentials.json');
const BCRYPT_ROUNDS = 10;

// SLSEA accounts. Colombo and Gampaha are neighbouring districts in the same province, and
// Western and Central are two provinces, so tests can prove one jurisdiction can't read another.
const USERS = [
  { _id: 'USR-001', name: 'National Analyst', email: 'national.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'national', status: 'active' },
  { _id: 'USR-002', name: 'Western Province Analyst', email: 'western.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'province', province_id: 'PV-01', status: 'active' },
  { _id: 'USR-003', name: 'Central Province Analyst', email: 'central.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'province', province_id: 'PV-02', status: 'active' },
  { _id: 'USR-004', name: 'Colombo District Analyst', email: 'colombo.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-01', status: 'active' },
  { _id: 'USR-005', name: 'Gampaha District Analyst', email: 'gampaha.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-02', status: 'active' },
  // Withdrawn account, so a valid password with an inactive status can be tested.
  { _id: 'USR-006', name: 'Kandy District Analyst (inactive)', email: 'kandy.analyst@slsea.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-04', status: 'inactive' },
  { _id: 'USR-007', name: 'Registry Admin', email: 'registry.admin@slsea.example', role: 'registry_admin', jurisdiction_level: 'national', status: 'active' },
];

// Random bytes from the operating system's secure generator (never the seeded generator,
// which is predictable by design), as URL-safe text.
const newSecret = (bytes) => crypto.randomBytes(bytes).toString('base64url');

function writeCredentials(devices, accounts) {
  const file = {
    note: 'Local only. Never commit or share. New secrets are generated on every seed run, so older copies stop working.',
    generated_at: new Date().toISOString(),
    users: accounts.map(({ _id, email, password, role, jurisdiction_level, province_id, district_id, status }) => ({
      user_id: _id,
      email,
      password,
      role,
      jurisdiction_level,
      ...(province_id && { province_id }),
      ...(district_id && { district_id }),
      status,
    })),
    devices,
  };
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // mode only applies when the file is first created, so tighten an existing file too: owner read/write only.
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const INTERVAL_MS = 15 * MINUTE_MS;
const DAYS = 8;
// Asia/Colombo is UTC+05:30 all year (Sri Lanka has no daylight saving), so a fixed offset is exact.
const COLOMBO_OFFSET_MS = 5.5 * HOUR_MS;
// Registered but not reporting yet, so "no readings" behaviour (last_reading: null, 404) can be tested.
const NO_READINGS = ['INS-0030', 'INS-0105', 'INS-0219'];
const CLOUDY_DAY_COUNT = 2;
const BATCH_SIZE = 5000;

const round = (n, places) => Number(n.toFixed(places));
const colomboHour = (ms) => ((ms + COLOMBO_OFFSET_MS) % DAY_MS) / HOUR_MS;
const colomboDate = (ms) => new Date(ms + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);

// The last 8 days, on quarter-hour boundaries. Because +05:30 is a whole number of quarter-hours,
// UTC quarter-hours are also Sri Lanka quarter-hours (06:00, 06:15, ...).
function readingWindow(now) {
  const end = Math.floor(now / INTERVAL_MS) * INTERVAL_MS;
  return { start: end - DAYS * DAY_MS + INTERVAL_MS, end };
}

// Clear-sky shape: zero before sunrise and after sunset in Sri Lanka time, peaking around midday.
// Near the equator these times barely change through the year.
function daylight(hour) {
  const SUNRISE = 6.1;
  const SUNSET = 18.2;
  if (hour <= SUNRISE || hour >= SUNSET) return 0;
  return Math.sin((Math.PI * (hour - SUNRISE)) / (SUNSET - SUNRISE));
}

// Weather per Sri Lanka calendar day: mostly clear, with a few heavily clouded days nationwide.
function dailyWeather({ start, end }, random) {
  const dates = [];
  for (let t = start; t <= end; t += DAY_MS) dates.push(colomboDate(t));
  if (!dates.includes(colomboDate(end))) dates.push(colomboDate(end));

  const cloudy = new Set();
  while (cloudy.size < CLOUDY_DAY_COUNT) cloudy.add(dates[Math.floor(random() * dates.length)]);

  const weather = new Map();
  for (const date of dates) {
    weather.set(
      date,
      cloudy.has(date)
        ? { cloudy: true, clearness: 0.3 + random() * 0.2, variability: 0.35 }
        : { cloudy: false, clearness: 0.85 + random() * 0.15, variability: 0.05 }
    );
  }
  return weather;
}

function generateReadings(installation, window, weather, random, now) {
  const between = (min, max) => min + random() * (max - min);
  // Panel orientation, shading and losses differ per site.
  const performance = between(0.75, 0.85);
  // Meter total at the start of the window: roughly 4 kWh per kW of panels per day since commissioning.
  const daysRunning = (window.start - Date.parse(installation.commissioned_at)) / DAY_MS;
  let energy = round(installation.capacity_kw * daysRunning * 4 * between(0.85, 1.0), 1);
  // A decommissioned site stopped reporting at some point inside the window.
  const stopAt = installation.status === 'inactive' ? window.start + Math.floor(random() * DAYS) * DAY_MS : Infinity;

  const readings = [];
  let previousPower = 0;
  for (let t = window.start; t <= window.end && t < stopAt; t += INTERVAL_MS) {
    const sun = daylight(colomboHour(t));
    const day = weather.get(colomboDate(t));
    const cloud = sun > 0 ? Math.min(1, Math.max(0.05, day.clearness * (1 + (random() * 2 - 1) * day.variability))) : 0;
    const power = round(installation.capacity_kw * performance * sun * cloud, 2);

    // Energy added over the last 15 minutes = average power x 0.25 h, so the total can only grow.
    energy += ((previousPower + power) / 2) * 0.25;
    previousPower = power;

    // Usually a few seconds' delay; occasionally a reading arrives minutes late.
    const delay = random() < 0.01 ? between(2, 30) * MINUTE_MS : between(2, 15) * 1000;

    readings.push({
      _id: new mongoose.Types.ObjectId().toHexString(),
      installation_id: installation.installation_id,
      timestamp: new Date(t),
      power_kw: power,
      // Rounding never makes a growing number smaller, so the stored total still never decreases.
      energy_kwh: round(energy, 2),
      // Grid voltage around 230 V, rising slightly when the site exports at midday.
      voltage: round(230 + 5 * sun * cloud + (random() * 2 - 1) * 1.5, 1),
      // The newest readings are only minutes old, so a late arrival could otherwise land after the
      // seed ran. A reading can't be received in the future, and received_at feeds Last-Modified.
      received_at: new Date(Math.min(t + Math.round(delay), now)),
      substation_id: installation.substation_id,
      district_id: installation.district_id,
      province_id: installation.province_id,
    });
  }
  return readings;
}

// The seed file uses the API's id names; MongoDB stores the id as _id.
const toDocs = (records, idField) => records.map(({ [idField]: _id, ...rest }) => ({ _id, ...rest }));

async function main() {
  const connection = await connectToDatabase();
  const target = `${connection.host} / database "${connection.name}"`;

  if (!process.argv.includes('--yes')) {
    console.log(`Target: ${target}`);
    console.log('This deletes and reloads provinces, districts, grid_substations, installations, generation_readings and users,');
    console.log(`and writes new credentials to ${path.relative(process.cwd(), CREDENTIALS_FILE)}.`);
    console.log('Run again with --yes to continue:  npm run seed -- --yes');
    process.exitCode = 1;
    return;
  }
  console.log(`Seeding ${target}`);

  // New credentials every run. The file is written before the hashes reach the database,
  // so a secret can never exist only as an unrecoverable hash.
  const devices = hierarchy.installations.map(({ installation_id, meter_id }) => ({
    installation_id,
    meter_id,
    device_secret: newSecret(32),
  }));
  const accounts = USERS.map((user) => ({ ...user, password: newSecret(18) }));
  writeCredentials(devices, accounts);

  const secretFor = new Map(devices.map((d) => [d.installation_id, d.device_secret]));
  const installationDocs = await Promise.all(
    toDocs(hierarchy.installations, 'installation_id').map(async (doc) => ({
      ...doc,
      device_secret_hash: await bcrypt.hash(secretFor.get(doc._id), BCRYPT_ROUNDS),
    }))
  );
  const userDocs = await Promise.all(
    accounts.map(async ({ password, ...user }) => ({
      ...user,
      password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    }))
  );

  // Hashing is done above, while the old data is still live, so the database is only empty
  // for the delete-then-insert below. Children first, so no reading is ever left pointing at
  // a deleted installation.
  for (const Model of [GenerationReading, SolarInstallation, GridSubstation, District, Province, User]) {
    await Model.deleteMany({});
  }

  await Province.insertMany(toDocs(hierarchy.provinces, 'province_id'));
  await District.insertMany(toDocs(hierarchy.districts, 'district_id'));
  await GridSubstation.insertMany(toDocs(hierarchy.substations, 'substation_id'));
  await SolarInstallation.insertMany(installationDocs);
  await User.insertMany(userDocs);

  const random = makeRandom(2026);
  const now = Date.now();
  const window = readingWindow(now);
  const weather = dailyWeather(window, random);

  let batch = [];
  let total = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await GenerationReading.insertMany(batch);
    total += batch.length;
    batch = [];
  };

  for (const installation of hierarchy.installations) {
    if (NO_READINGS.includes(installation.installation_id)) continue;
    for (const reading of generateReadings(installation, window, weather, random, now)) {
      batch.push(reading);
      if (batch.length >= BATCH_SIZE) await flush();
    }
  }
  await flush();

  const colombo = (ms) => `${new Date(ms + COLOMBO_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} Sri Lanka time`;
  const cloudyDays = [...weather].filter(([, w]) => w.cloudy).map(([date]) => date);
  console.log(`  provinces       ${hierarchy.provinces.length}`);
  console.log(`  districts       ${hierarchy.districts.length}`);
  console.log(`  substations     ${hierarchy.substations.length}`);
  console.log(`  installations   ${hierarchy.installations.length} (no readings: ${NO_READINGS.join(', ')})`);
  console.log(`  readings        ${total}`);
  console.log(`  users           ${USERS.length} (national, 2 province, 3 district incl. 1 inactive, 1 registry admin)`);
  console.log(`  device secrets  ${devices.length}, hashed with bcrypt`);
  console.log(`  credentials     ${path.relative(process.cwd(), CREDENTIALS_FILE)} (git-ignored, owner-only)`);
  console.log(`  window          ${colombo(window.start)} to ${colombo(window.end)}`);
  console.log(`  cloudy days     ${cloudyDays.join(', ')}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('seed failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

module.exports = { readingWindow, daylight, dailyWeather, generateReadings, NO_READINGS };
