// Loads seed/hierarchy.json and generates 8 days of readings ending now.
//   npm run seed -- --yes
// Idempotent: each run deletes the seeded collections and reloads them, so re-running never
// duplicates anything and moves the reading window up to "now" (re-seed before submission and
// the viva so the last-known readings and today's summary are fresh).
// Run scripts/setup-db.js first so the unique installation_id + timestamp index exists.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const { connectToDatabase } = require('../src/config/db');
const { makeRandom } = require('./lib/random');
const Province = require('../src/models/province');
const District = require('../src/models/district');
const GridSubstation = require('../src/models/grid-substation');
const SolarInstallation = require('../src/models/solar-installation');
const GenerationReading = require('../src/models/generation-reading');
const hierarchy = require('../seed/hierarchy.json');

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

function generateReadings(installation, window, weather, random) {
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
      received_at: new Date(t + Math.round(delay)),
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
    console.log('This deletes and reloads provinces, districts, grid_substations, installations and generation_readings.');
    console.log('Run again with --yes to continue:  npm run seed -- --yes');
    process.exitCode = 1;
    return;
  }
  console.log(`Seeding ${target}`);

  // Children first, so no reading is ever left pointing at a deleted installation.
  for (const Model of [GenerationReading, SolarInstallation, GridSubstation, District, Province]) {
    await Model.deleteMany({});
  }

  await Province.insertMany(toDocs(hierarchy.provinces, 'province_id'));
  await District.insertMany(toDocs(hierarchy.districts, 'district_id'));
  await GridSubstation.insertMany(toDocs(hierarchy.substations, 'substation_id'));
  await SolarInstallation.insertMany(toDocs(hierarchy.installations, 'installation_id'));

  const random = makeRandom(2026);
  const window = readingWindow(Date.now());
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
    for (const reading of generateReadings(installation, window, weather, random)) {
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
