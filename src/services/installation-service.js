const SolarInstallation = require('../models/solar-installation');
const GridSubstation = require('../models/grid-substation');
const District = require('../models/district');
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

// The jurisdiction copies for an installation always come from its substation, never from the
// client. An unknown substation is a problem with a field in the body (400), not a missing URI (404).
async function jurisdictionFor(substationId) {
  const substation = await GridSubstation.findById(substationId);
  if (!substation) {
    throw new ApiError(400, 'UNKNOWN_SUBSTATION', `No grid substation with id ${substationId}.`, [
      { field: 'substation_id', location: 'body', issue: 'No grid substation with this id exists.', reference: null },
    ]);
  }
  const district = await District.findById(substation.district_id);
  return { district_id: substation.district_id, province_id: district.province_id };
}

// Registry: a new installation. The unique indexes on _id and meter_id refuse clashes, which is
// safe even when two requests race; the refusal becomes a 409 naming what was taken.
async function registerInstallation({ installation_id, ...fields }) {
  const jurisdiction = await jurisdictionFor(fields.substation_id);
  try {
    return await SolarInstallation.create({ _id: installation_id, ...fields, ...jurisdiction });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern._id) {
      throw new ApiError(409, 'INSTALLATION_ID_TAKEN', `Installation ${installation_id} is already registered.`, [
        { field: 'installation_id', location: 'body', issue: 'Already registered.', reference: `/installations/${installation_id}` },
      ]);
    }
    throw meterTakenOr(err, fields.meter_id);
  }
}

function meterTakenOr(err, meterId) {
  if (err.code === 11000 && err.keyPattern && err.keyPattern.meter_id) {
    return new ApiError(409, 'METER_ID_TAKEN', `Meter ${meterId} is already fitted to another installation.`, [
      { field: 'meter_id', location: 'body', issue: 'Already used by another installation.', reference: null },
    ]);
  }
  return err;
}

// Registry: whole-document replacement. Every writable field comes from the body (validated as
// complete beforehand), so nothing from the old version survives by accident: there is no merge.
// The jurisdiction copies are recalculated from the substation. Only server-managed fields are
// kept: the meter's credential hash (a replacement must not lock the device out) and created_at.
// Readings are untouched; they keep the jurisdiction they were recorded under.
async function replaceInstallation(installationId, fields) {
  const existing = await SolarInstallation.findById(installationId).select('+device_secret_hash');
  if (!existing) throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  const jurisdiction = await jurisdictionFor(fields.substation_id);

  existing.overwrite({ ...fields, ...jurisdiction, device_secret_hash: existing.device_secret_hash, created_at: existing.created_at });
  try {
    await existing.save();
  } catch (err) {
    throw meterTakenOr(err, fields.meter_id);
  }
  const lastReading = await getLastReading(installationId);
  return { installation: existing, body: { ...existing.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null } };
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
// The parent must exist first (404), and only then are the query values checked (400),
// following the design's check order. `parseQuery` reads page, page-size and the time window.
async function listInstallationReadings(installationId, parseQuery) {
  await ensureInstallationExists(installationId);
  const { page, pageSize, timestamp } = parseQuery();
  const { results, count } = await listReadings(installationId, { skip: (page - 1) * pageSize, limit: pageSize, timestamp });
  return { page, pageSize, results, count };
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

// Registry: remove an installation. Find-and-delete is one atomic step, so of two simultaneous
// DELETEs exactly one succeeds and the other gets 404. Its readings are NOT deleted (no cascade):
// they are the evidence of what was generated, and deleting the asset must not erase that history.
// Returns the composite as it was just before removal.
async function deleteInstallation(installationId) {
  const removed = await SolarInstallation.findOneAndDelete({ _id: installationId });
  if (!removed) throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  const lastReading = await getLastReading(installationId);
  return { ...removed.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null };
}

module.exports = {
  deleteInstallation,
  ensureInstallationExists,
  replaceInstallation,
  registerInstallation,
  createReading,
  listInstallations,
  getInstallation,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
};
