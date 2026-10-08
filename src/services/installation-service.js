const SolarInstallation = require('../models/solar-installation');
const { notFound } = require('../utils/errors');
const { getLastReading, listReadings, findReading } = require('./reading-service');

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

module.exports = {
  listInstallations,
  getInstallation,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
};
