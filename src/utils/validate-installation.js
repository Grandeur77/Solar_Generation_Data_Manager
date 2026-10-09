const { ApiError } = require('./errors');
const { parseInstant } = require('./iso-time');

const WRITABLE = ['name', 'meter_id', 'substation_id', 'capacity_kw', 'status', 'commissioned_at', 'address', 'latitude', 'longitude'];
// Set by the server and never accepted from a client.
const SERVER_SET = {
  district_id: 'Not accepted: the server copies it from the substation.',
  province_id: 'Not accepted: the server copies it from the substation.',
  last_reading: 'Not accepted: it is derived from the readings.',
};

const detail = (field, issue) => ({ field, location: 'body', issue, reference: null });
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// Structural checks on an installation body. Every problem is reported at once.
// requireInstallationId: true for POST (the admin supplies the readable id).
function validateInstallationBody(body, { requireInstallationId }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The body must be a JSON object.', [detail(null, 'Send an object with the installation fields.')]);
  }

  const problems = [];
  const accepted = requireInstallationId ? ['installation_id', ...WRITABLE] : WRITABLE;
  for (const field of Object.keys(body)) {
    if (SERVER_SET[field]) problems.push(detail(field, SERVER_SET[field]));
    else if (!accepted.includes(field)) problems.push(detail(field, 'Not an accepted field.'));
  }

  const check = (field, ok, issue) => {
    if (body[field] === undefined) problems.push(detail(field, 'Required.'));
    else if (!ok(body[field])) problems.push(detail(field, issue));
  };
  if (requireInstallationId) check('installation_id', (v) => /^INS-\d{4}$/.test(v), 'Must look like INS-0001.');
  check('name', isText, 'Must be non-empty text.');
  check('meter_id', (v) => /^MTR-\d{6}$/.test(v), 'Must look like MTR-000001.');
  check('substation_id', (v) => /^SS-\d{3}$/.test(v), 'Must look like SS-001.');
  check('capacity_kw', (v) => isNumber(v) && v > 0, 'Must be a number greater than 0.');
  check('status', (v) => v === 'active' || v === 'inactive', 'Must be "active" or "inactive".');
  check('commissioned_at', (v) => parseInstant(v) !== null, 'Must be an ISO-8601 date-time with a time zone, e.g. 2026-10-01T00:00:00Z.');
  check('address', isText, 'Must be non-empty text.');
  check('latitude', (v) => isNumber(v) && v >= -90 && v <= 90, 'Must be a number from -90 to 90.');
  check('longitude', (v) => isNumber(v) && v >= -180 && v <= 180, 'Must be a number from -180 to 180.');

  if (problems.length > 0) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    throw new ApiError(400, 'VALIDATION_FAILED', `The installation has ${problems.length} ${noun}.`, problems);
  }

  const fields = Object.fromEntries(WRITABLE.map((f) => [f, body[f]]));
  fields.commissioned_at = new Date(body.commissioned_at);
  if (requireInstallationId) fields.installation_id = body.installation_id;
  return fields;
}

// PUT body: the whole installation without the id, which comes from the path. An installation_id
// in the body is allowed only if it equals the path id; a different one is ID_MISMATCH, because
// PUT can't rename an installation (or replace a different one than the URI names).
function validateReplacementBody(body, pathInstallationId) {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'installation_id' in body) {
    const { installation_id: bodyId, ...rest } = body;
    if (bodyId !== pathInstallationId) {
      throw new ApiError(400, 'ID_MISMATCH', `The body's installation_id does not match the URL (${pathInstallationId}).`, [
        { field: 'installation_id', location: 'body', issue: `Must equal ${pathInstallationId}, or be left out.`, reference: `/installations/${pathInstallationId}` },
      ]);
    }
    return validateInstallationBody(rest, { requireInstallationId: false });
  }
  return validateInstallationBody(body, { requireInstallationId: false });
}

module.exports = { validateInstallationBody, validateReplacementBody };
