const SolarInstallation = require('../models/solar-installation');
const { ApiError, notFound } = require('../utils/errors');
const {
  getLastReading,
  listReadings,
  findReading,
  findReadingAt,
  findNeighbours,
  insertReading,
} = require('./reading-service');
const { plausibilityProblems } = require('../utils/reading-rules');

// Filters combine (AND). Installations carry copies of their district and province ids,
// so every filter is a direct, indexed match with no lookup through the substation.
async function listInstallations({ provinceId, districtId, substationId } = {}) {
  const filter = {};
  if (provinceId) filter.province_id = provinceId;
  if (districtId) filter.district_id = districtId;
  if (substationId) filter.substation_id = substationId;
  return SolarInstallation.find(filter).sort({ _id: 1 });
}

async function getInstallation(installationId) {
  const installation = await SolarInstallation.findById(installationId);
  if (!installation) throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  return installation;
}

// The composite: the installation's own fields plus exactly one nested reading (or null).
// Never the history, and never flat last_* fields copied onto the installation.
async function getInstallationComposite(installationId) {
  const installation = await getInstallation(installationId);
  const lastReading = await getLastReading(installationId);
  return { ...installation.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null };
}

// Every resource under /installations/{installation-id}/ needs its parent to exist first.
// exists() checks the id without loading the whole installation document.
async function ensureInstallationExists(installationId) {
  if (!(await SolarInstallation.exists({ _id: installationId }))) {
    throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  }
}

// The processing resource: only the latest reading, no installation metadata.
// Two different 404s, so a client can tell "no such site" from "site not reporting yet".
async function getLastKnownReading(installationId) {
  await ensureInstallationExists(installationId);
  const reading = await getLastReading(installationId);
  if (!reading) {
    throw notFound('NO_READINGS_YET', `Installation ${installationId} has not reported any readings yet.`);
  }
  return reading;
}

// Scoped collection: a missing parent is 404, an existing parent with no readings is 200 [].
async function listInstallationReadings(installationId) {
  await ensureInstallationExists(installationId);
  return listReadings(installationId);
}

// Scoped member: the reading must belong to this installation.
async function getInstallationReading(installationId, readingId) {
  await ensureInstallationExists(installationId);
  const reading = await findReading(installationId, readingId);
  if (!reading) {
    throw notFound('READING_NOT_FOUND', `Installation ${installationId} has no reading with id ${readingId}.`);
  }
  return reading;
}

// A device's new reading. Everything the client could get wrong comes from elsewhere:
// the installation from the URL path, the jurisdiction ids from the stored installation
// (so a device can't file readings under another district), and received_at from the server clock.
async function createReading(installationId, values) {
  const installation = await getInstallation(installationId);

  // Physically impossible readings are refused, all problems reported at once.
  const neighbours = await findNeighbours(installationId, values.timestamp);
  const problems = plausibilityProblems(installation, values, { ...neighbours, now: Date.now() });
  if (problems.length > 0) {
    const noun = problems.length === 1 ? 'value is' : 'values are';
    throw new ApiError(400, 'READING_IMPLAUSIBLE', `${problems.length} ${noun} physically implausible for this installation.`, problems);
  }

  try {
    return await insertReading({
      ...values,
      installation_id: installation._id,
      received_at: new Date(),
      substation_id: installation.substation_id,
      district_id: installation.district_id,
      province_id: installation.province_id,
    });
  } catch (err) {
    // The unique { installation_id, timestamp } index refused a second reading for the same
    // moment. Catching the refusal (instead of checking first) is safe even when two
    // requests race. The stored reading is never overwritten: readings are append-only.
    if (err.code === 11000 && err.keyPattern && err.keyPattern.timestamp) {
      throw await duplicateReadingError(installationId, values.timestamp);
    }
    throw err;
  }
}

async function duplicateReadingError(installationId, timestamp) {
  const existing = await findReadingAt(installationId, timestamp);
  const location = `/installations/${installationId}/readings/${existing._id}`;
  return new ApiError(
    409,
    'READING_DUPLICATE',
    `Installation ${installationId} already has a reading at ${timestamp.toISOString()}.`,
    [{ field: 'timestamp', location: 'body', issue: 'A reading for this installation and timestamp already exists.', reference: location }]
  );
}

module.exports = {
  createReading,
  listInstallations,
  getInstallation,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
};
