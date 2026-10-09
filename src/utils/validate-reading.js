const { ApiError } = require('./errors');

const ALLOWED = ['timestamp', 'power_kw', 'energy_kwh', 'voltage'];
// ISO-8601 date-time that states its time zone (Z or +05:30), so the instant is unambiguous.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const detail = (field, issue) => ({ field, location: 'body', issue, reference: null });
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// Structural checks on a new reading. Every problem is reported at once, one details entry each.
// Returns the four values with timestamp as a Date.
function validateNewReading(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The body must be a JSON object.', [
      detail(null, 'Send an object with timestamp, power_kw, energy_kwh and voltage.'),
    ]);
  }

  const problems = [];
  for (const field of Object.keys(body)) {
    if (field === 'installation_id') {
      problems.push(detail(field, 'Not accepted in the body: the installation comes from the URL path.'));
    } else if (!ALLOWED.includes(field)) {
      problems.push(detail(field, 'Not an accepted field. The server sets reading_id, received_at and the jurisdiction ids.'));
    }
  }

  const { timestamp, power_kw, energy_kwh, voltage } = body;
  if (timestamp === undefined) problems.push(detail('timestamp', 'Required.'));
  else if (typeof timestamp !== 'string' || !ISO_WITH_ZONE.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    problems.push(detail('timestamp', 'Must be an ISO-8601 date-time with a time zone, e.g. 2026-10-06T04:30:00Z.'));
  }
  if (power_kw === undefined) problems.push(detail('power_kw', 'Required.'));
  else if (!isNumber(power_kw) || power_kw < 0) problems.push(detail('power_kw', 'Must be a number, 0 or more.'));
  if (energy_kwh === undefined) problems.push(detail('energy_kwh', 'Required.'));
  else if (!isNumber(energy_kwh) || energy_kwh < 0) problems.push(detail('energy_kwh', 'Must be a number, 0 or more.'));
  if (voltage === undefined) problems.push(detail('voltage', 'Required.'));
  else if (!isNumber(voltage)) problems.push(detail('voltage', 'Must be a number.'));

  if (problems.length > 0) {
    const noun = problems.length === 1 ? 'problem' : 'problems';
    throw new ApiError(400, 'VALIDATION_FAILED', `The reading has ${problems.length} ${noun}.`, problems);
  }
  return { timestamp: new Date(timestamp), power_kw, energy_kwh, voltage };
}

module.exports = { validateNewReading };
