const GenerationReading = require('../models/generation-reading');

// The one place that decides which reading is "the latest": newest by measurement time,
// not by insertion order, so a late-arriving older reading never replaces it.
// The unique { installation_id, timestamp: -1 } index answers this without scanning the history.
// Returns null when the installation has no readings yet.
async function getLastReading(installationId) {
  return GenerationReading.findOne({ installation_id: installationId }).sort({ timestamp: -1 });
}

// One installation's history, newest first. Every query names the installation,
// so a reading can only ever be reached through its own installation (the scope).
async function listReadings(installationId) {
  return GenerationReading.find({ installation_id: installationId }).sort({ timestamp: -1 });
}

// Matches on both ids: a real reading id under the wrong installation is not found.
async function findReading(installationId, readingId) {
  return GenerationReading.findOne({ _id: readingId, installation_id: installationId });
}

module.exports = { getLastReading, listReadings, findReading };
