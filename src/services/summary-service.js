const GenerationReading = require('../models/generation-reading');
const SolarInstallation = require('../models/solar-installation');
const { sriLankaDay } = require('../utils/sri-lanka-day');

// Every function here takes a scope, { district_id } or { province_id }, so the district and
// province summaries share one calculation and can never disagree about how a figure is worked out.

// Current total power across the scope for one Sri Lanka day
// ({ start, end } from sriLankaDay). The whole calculation runs inside MongoDB; Node only
// receives the final one-row answer, never the readings.
//
// Only installations that reported in the day count, so a site that stopped days ago does not
// add old power to "now". For today this is current power; for a past day, power at its end.
async function currentTotalPower(scope, { start, end }) {
  const [row] = await GenerationReading.aggregate([
    // 1. The scope's readings inside the day (uses the { district_id, timestamp } or { province_id, timestamp } index).
    { $match: { ...scope, timestamp: { $gte: start, $lt: end } } },
    // 2. Newest first within each installation, so $first below is the latest reading.
    //    Sorted by measurement time, never insertion order: a late-arriving older reading is not "latest".
    { $sort: { installation_id: 1, timestamp: -1 } },
    // 3. One row per installation: its latest power and when it was measured.
    { $group: { _id: '$installation_id', power_kw: { $first: '$power_kw' }, timestamp: { $first: '$timestamp' } } },
    // 4. One row for the scope: the sum, the newest reading included, and how many installations reported.
    {
      $group: {
        _id: null,
        total_power_kw: { $sum: '$power_kw' },
        power_as_of: { $max: '$timestamp' },
        reporting_installations: { $sum: 1 },
      },
    },
    // 5. Round to 3 dp (1 W) so floating-point noise like 0.30000000000000004 never reaches the client.
    { $project: { _id: 0, total_power_kw: { $round: ['$total_power_kw', 3] }, power_as_of: 1, reporting_installations: 1 } },
  ]);
  // No reading in the day means no row at all: nothing is generating that we know of.
  return row || { total_power_kw: 0, power_as_of: null, reporting_installations: 0 };
}

// Energy generated across the scope in one Sri Lanka day.
// energy_kwh is a cumulative meter total, so a reading's energy since the reading before it is
// the difference between the two totals. Day energy is the sum of those increases for every
// reading in the day; the first one compares with the installation's last reading before the
// day, so energy from midnight to the first reading is counted.
// A drop (a replaced or reset meter, or a bad value) counts as 0, never as negative energy:
// the next increase is then measured from the new, lower total.
async function dayEnergy(scope, { start, end }) {
  const [row] = await GenerationReading.aggregate([
    // 1. Everything up to the end of the day; no lower bound, because the reading before the
    //    day's first can be from any earlier day.
    { $match: { ...scope, timestamp: { $lt: end } } },
    // 2. Give every reading the total of the installation's reading just before it, by timestamp
    //    (null for its very first reading).
    {
      $setWindowFields: {
        partitionBy: '$installation_id',
        sortBy: { timestamp: 1 },
        output: { previous_kwh: { $shift: { output: '$energy_kwh', by: -1 } } },
      },
    },
    // 3. Only the day's readings now; each still knows the total before it.
    { $match: { timestamp: { $gte: start } } },
    // 4. Add up the increases. An installation's first reading ever has nothing to compare with
    //    (0), and a drop is 0, not negative.
    {
      $group: {
        _id: null,
        day_energy_kwh: {
          $sum: { $cond: [{ $eq: ['$previous_kwh', null] }, 0, { $max: [0, { $subtract: ['$energy_kwh', '$previous_kwh'] }] }] },
        },
      },
    },
    // 5. Round to 3 dp (1 Wh): 1020.1 − 1000 is 20.100000000000023 in floating point.
    { $project: { _id: 0, day_energy_kwh: { $round: ['$day_energy_kwh', 3] } } },
  ]);
  return row ? row.day_energy_kwh : 0;
}

// The highest combined output in the day, and the 15-minute slot it happened in. Readings are
// grouped into 15-minute slots (the reporting interval), so a device a few seconds off the grid
// is still added to its neighbours. Sri Lanka's +05:30 offset is a whole number of 15-minute
// slots, so UTC slots line up with Sri Lanka slots.
async function peakPower(scope, { start, end }) {
  const slot = { $dateTrunc: { date: '$timestamp', unit: 'minute', binSize: 15 } };
  const [row] = await GenerationReading.aggregate([
    // 1. The scope's readings inside the day.
    { $match: { ...scope, timestamp: { $gte: start, $lt: end } } },
    // 2. One value per installation per slot, so two readings from one site in a slot are not added twice.
    { $group: { _id: { slot, installation_id: '$installation_id' }, power_kw: { $max: '$power_kw' } } },
    // 3. The scope's combined output in each slot.
    { $group: { _id: '$_id.slot', total_kw: { $sum: '$power_kw' } } },
    // A day with no generation has no peak: 0 and null, rather than "0 kW at 23:45".
    { $match: { total_kw: { $gt: 0 } } },
    // 4. Highest first; on a tie, the earliest slot.
    { $sort: { total_kw: -1, _id: 1 } },
    { $limit: 1 },
    { $project: { _id: 0, peak_power_kw: { $round: ['$total_kw', 3] }, peak_at: '$_id' } },
  ]);
  // No reading, or nothing above 0 all day.
  return row || { peak_power_kw: 0, peak_at: null };
}

// Installed capacity and installation count from the registry (the installations as they are now).
async function registryTotals(scope) {
  const [row] = await SolarInstallation.aggregate([
    { $match: scope },
    { $group: { _id: null, installed_capacity_kw: { $sum: '$capacity_kw' }, installation_count: { $sum: 1 } } },
    { $project: { _id: 0, installed_capacity_kw: { $round: ['$installed_capacity_kw', 3] }, installation_count: 1 } },
  ]);
  return row || { installed_capacity_kw: 0, installation_count: 0 };
}

// The summary for one scope and one Sri Lanka day ('YYYY-MM-DD'). Every reading-based figure uses
// the same day window, so they all describe the same day.
async function generationSummary(scope, date) {
  const day = sriLankaDay(date);
  const [power, energy, peak, registry] = await Promise.all([
    currentTotalPower(scope, day),
    dayEnergy(scope, day),
    peakPower(scope, day),
    registryTotals(scope),
  ]);
  // Current output as a share of what is installed (0.15 = 15%). It can pass 1 slightly, because
  // panels may briefly exceed their rating. No installations means nothing to divide by: null.
  const utilisation =
    registry.installed_capacity_kw > 0 ? Math.round((power.total_power_kw / registry.installed_capacity_kw) * 1000) / 1000 : null;
  return {
    date,
    total_power_kw: power.total_power_kw,
    power_as_of: power.power_as_of,
    day_energy_kwh: energy,
    peak_power_kw: peak.peak_power_kw,
    peak_at: peak.peak_at,
    installed_capacity_kw: registry.installed_capacity_kw,
    capacity_utilisation: utilisation,
    installation_count: registry.installation_count,
    reporting_installations: power.reporting_installations,
  };
}

const districtGenerationSummary = async (districtId, date) => ({
  district_id: districtId,
  ...(await generationSummary({ district_id: districtId }, date)),
});

const provinceGenerationSummary = async (provinceId, date) => ({
  province_id: provinceId,
  ...(await generationSummary({ province_id: provinceId }, date)),
});

module.exports = {
  currentTotalPower,
  dayEnergy,
  peakPower,
  registryTotals,
  generationSummary,
  districtGenerationSummary,
  provinceGenerationSummary,
};
