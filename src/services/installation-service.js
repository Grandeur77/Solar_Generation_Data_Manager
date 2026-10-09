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
  removeReading,
} = require('./reading-service');
const { plausibilityProblems } = require('../utils/reading-rules');
const { newest } = require('../utils/http-cache');
const { jurisdictionFilter, checkFilter, checkMember } = require('./jurisdiction-service');

// Registry writes need the asset-admin scope, and only the registry admin has it, who is always
// national (the User model enforces it). Their reads of the latest reading say so explicitly.
const WHOLE_REGISTRY = {};

// Filters combine (AND), and each must overlap the caller's jurisdiction (403 otherwise).
// Installations carry copies of their district and province ids, so the jurisdiction and every
// filter are direct, indexed matches with no lookup through the substation. $and keeps them apart,
// so a filter can never overwrite the jurisdiction. One page plus the total across all pages.
async function listInstallations({ provinceId, districtId, substationId, status } = {}, { skip = 0, limit = 0, sort = { _id: 1 } } = {}, auth) {
  if (provinceId) await checkFilter(auth, 'province', provinceId, 'province-id');
  if (districtId) await checkFilter(auth, 'district', districtId, 'district-id');
  if (substationId) await checkFilter(auth, 'substation', substationId, 'substation-id');

  const conditions = [jurisdictionFilter(auth)];
  if (provinceId) conditions.push({ province_id: provinceId });
  if (districtId) conditions.push({ district_id: districtId });
  if (substationId) conditions.push({ substation_id: substationId });
  if (status) conditions.push({ status });
  const filter = { $and: conditions };
  const [results, count] = await Promise.all([
    SolarInstallation.find(filter).sort(sort).skip(skip).limit(limit),
    SolarInstallation.countDocuments(filter),
  ]);
  return { results, count };
}

// Write path only (a meter's reading): the meter's own installation, no jurisdiction involved.
async function getInstallation(installationId) {
  const installation = await SolarInstallation.findById(installationId);
  if (!installation) throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  return installation;
}

// Read path: 404 if it doesn't exist, then 403 if it is outside the caller's jurisdiction.
// Everything under /installations/{installation-id} starts here.
async function getReadableInstallation(installationId, auth) {
  const installation = await getInstallation(installationId);
  checkMember(auth, { province_id: installation.province_id, district_id: installation.district_id }, 'installation', 'installation-id');
  return installation;
}

// The composite: the installation's own fields plus exactly one nested reading (or null).
// Never the history, and never flat last_* fields copied onto the installation.
// lastModified is the later of the installation's own change and its latest reading's arrival.
async function getInstallationComposite(installationId, auth) {
  const installation = await getReadableInstallation(installationId, auth);
  const lastReading = await getLastReading(installationId, jurisdictionFilter(auth));
  const body = { ...installation.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null };
  const lastModified = newest([installation.updated_at, lastReading && lastReading.received_at]);
  return { body, lastModified };
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
  const lastReading = await getLastReading(installationId, WHOLE_REGISTRY);
  return { installation: existing, body: { ...existing.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null } };
}

// The processing resource: only the latest reading, no installation metadata.
// Two different 404s, so a client can tell "no such site" from "site not reporting yet".
async function getLastKnownReading(installationId, auth) {
  await getReadableInstallation(installationId, auth);
  const reading = await getLastReading(installationId, jurisdictionFilter(auth));
  if (!reading) {
    throw notFound('NO_READINGS_YET', `Installation ${installationId} has not reported any readings yet.`);
  }
  return reading;
}

// Scoped collection: a missing parent is 404, an existing parent with no readings is 200 [].
// The parent must exist first (404), and only then are the query values checked (400),
// following the design's check order. `parseQuery` reads page, page-size, the time window and sort;
// what it parsed is returned alongside the results so the route can build the page links.
async function listInstallationReadings(installationId, auth, parseQuery) {
  await getReadableInstallation(installationId, auth);
  const query = parseQuery();
  const { page, pageSize, timestamp, minPowerKw, sort } = query;
  const scope = jurisdictionFilter(auth);
  const { results, count } = await listReadings(installationId, { skip: (page - 1) * pageSize, limit: pageSize, timestamp, minPowerKw, sort, scope });
  return { ...query, results, count };
}

// Scoped member: the reading must belong to this installation.
async function getInstallationReading(installationId, readingId, auth) {
  await getReadableInstallation(installationId, auth);
  const reading = await findReading(installationId, readingId, jurisdictionFilter(auth));
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

  let reading;
  try {
    reading = await insertReading({
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

  // Two readings sent at the same moment can each pass the energy check above before the other
  // is stored, leaving a total that goes down. Checking again now that ours is stored catches
  // that: if a neighbour stored meanwhile contradicts it, ours is taken back and refused, so the
  // stored totals never decrease. (Both racers may be refused; a retry is then checked normally.)
  const after = await findNeighbours(installationId, values.timestamp);
  const conflicts = plausibilityProblems(installation, values, { ...after, now: Date.now() }).filter((p) => p.field === 'energy_kwh');
  if (conflicts.length > 0) {
    await removeReading(reading._id);
    throw new ApiError(400, 'READING_IMPLAUSIBLE', 'energy_kwh conflicts with a reading stored at the same time.', conflicts);
  }
  return reading;
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
  const lastReading = await getLastReading(installationId, WHOLE_REGISTRY);
  return { ...removed.toJSON(), last_reading: lastReading ? lastReading.toJSON() : null };
}

module.exports = {
  deleteInstallation,
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
