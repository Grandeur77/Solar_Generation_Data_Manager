const GenerationReading = require('../models/generation-reading');

// The one place that decides which reading is "the latest": newest by measurement time,
// not by insertion order, so a late-arriving older reading never replaces it.
// The unique { installation_id, timestamp: -1 } index answers this without scanning the history.
// Returns null when the installation has no readings yet.
async function getLastReading(installationId) {
  return GenerationReading.findOne({ installation_id: installationId }).sort({ timestamp: -1 });
}

// One page of an installation's history, newest first, plus the total across all pages.
// Every query names the installation, so a reading can only be reached through its own
// installation (the scope). Both queries use the { installation_id, timestamp } index.
async function listReadings(installationId, { skip, limit, timestamp }) {
  const filter = { installation_id: installationId };
  // The time window filters on measurement time (timestamp), not on when the server received it.
  if (timestamp) filter.timestamp = timestamp;
  const [results, count] = await Promise.all([
    GenerationReading.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit),
    GenerationReading.countDocuments(filter),
  ]);
  return { results, count };
}

// Matches on both ids: a real reading id under the wrong installation is not found.
async function findReading(installationId, readingId) {
  return GenerationReading.findOne({ _id: readingId, installation_id: installationId });
}

// The reading an installation already has at an exact instant (used to point a duplicate at it).
async function findReadingAt(installationId, timestamp) {
  return GenerationReading.findOne({ installation_id: installationId, timestamp });
}

// The installation's readings immediately before and after an instant, by measurement time.
// Both use the { installation_id, timestamp } index.
async function findNeighbours(installationId, timestamp) {
  const [previous, next] = await Promise.all([
    GenerationReading.findOne({ installation_id: installationId, timestamp: { $lt: timestamp } }).sort({ timestamp: -1 }),
    GenerationReading.findOne({ installation_id: installationId, timestamp: { $gt: timestamp } }).sort({ timestamp: 1 }),
  ]);
  return { previous, next };
}

async function insertReading(data) {
  return GenerationReading.create(data);
}

module.exports = { getLastReading, listReadings, findReading, findReadingAt, findNeighbours, insertReading };
