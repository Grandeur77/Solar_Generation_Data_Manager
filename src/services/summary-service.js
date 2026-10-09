const GenerationReading = require('../models/generation-reading');

// Current total power across a district (scope = { district_id }) for one Sri Lanka day
// ({ start, end } from sriLankaDay). The whole calculation runs inside MongoDB; Node only
// receives the final one-row answer, never the readings.
//
// Only installations that reported in the day count, so a site that stopped days ago does not
// add old power to "now". For today this is current power; for a past day, power at its end.
async function currentTotalPower(scope, { start, end }) {
  const [row] = await GenerationReading.aggregate([
    // 1. This district's readings inside the day (uses the { district_id, timestamp } index).
    { $match: { ...scope, timestamp: { $gte: start, $lt: end } } },
    // 2. Newest first within each installation, so $first below is the latest reading.
    //    Sorted by measurement time, never insertion order: a late-arriving older reading is not "latest".
    { $sort: { installation_id: 1, timestamp: -1 } },
    // 3. One row per installation: its latest power and when it was measured.
    { $group: { _id: '$installation_id', power_kw: { $first: '$power_kw' }, timestamp: { $first: '$timestamp' } } },
    // 4. One row for the district: the sum, and the newest reading included in it.
    { $group: { _id: null, total_power_kw: { $sum: '$power_kw' }, power_as_of: { $max: '$timestamp' } } },
    // 5. Round to 3 dp (1 W) so floating-point noise like 0.30000000000000004 never reaches the client.
    { $project: { _id: 0, total_power_kw: { $round: ['$total_power_kw', 3] }, power_as_of: 1 } },
  ]);
  // No reading in the day means no row at all: nothing is generating that we know of.
  return row || { total_power_kw: 0, power_as_of: null };
}

module.exports = { currentTotalPower };
