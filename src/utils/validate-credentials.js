const { ApiError } = require('./errors');

const detail = (field, issue) => ({ field, location: 'body', issue, reference: null });
// bcrypt only uses the first 72 bytes, so a longer password would be partly ignored without
// anyone knowing. Refusing it is clearer than silently truncating.
const BCRYPT_MAX_BYTES = 72;
const isSecretText = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= BCRYPT_MAX_BYTES;
const SECRET_ISSUE = `Must be text of 1 to ${BCRYPT_MAX_BYTES} bytes.`;

const USER_FIELDS = ['email', 'password'];
const DEVICE_FIELDS = ['meter_id', 'device_secret'];

function fail(problems) {
  throw new ApiError(400, 'VALIDATION_FAILED', 'The credentials are not in the expected form.', problems);
}

// Body of POST /auth/tokens: exactly one credential pair, a person's { email, password } or a
// meter's { meter_id, device_secret }. A body with neither pair is treated as a person's, so it
// is told which two fields are missing. Every problem is reported at once; a password or secret
// is never echoed back in an error.
function validateTokenRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    fail([detail(null, 'Send { "email", "password" } or { "meter_id", "device_secret" }.')]);
  }

  const fields = Object.keys(body);
  const hasUserField = fields.some((f) => USER_FIELDS.includes(f));
  const hasDeviceField = fields.some((f) => DEVICE_FIELDS.includes(f));
  if (hasUserField && hasDeviceField) {
    fail([detail(null, 'Send one credential pair: email + password, or meter_id + device_secret, not both.')]);
  }
  const isDevice = hasDeviceField;
  const accepted = isDevice ? DEVICE_FIELDS : USER_FIELDS;

  const problems = [];
  for (const field of fields) {
    if (!accepted.includes(field)) problems.push(detail(field, 'Not an accepted field.'));
  }
  const check = (field, ok, issue) => {
    if (body[field] === undefined) problems.push(detail(field, 'Required.'));
    else if (!ok(body[field])) problems.push(detail(field, issue));
  };

  if (isDevice) {
    check('meter_id', (v) => typeof v === 'string' && /^MTR-\d{6}$/.test(v), 'Must look like MTR-000001.');
    check('device_secret', isSecretText, SECRET_ISSUE);
    if (problems.length > 0) fail(problems);
    return { kind: 'device', meter_id: body.meter_id, device_secret: body.device_secret };
  }

  check('email', (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), 'Must be an email address.');
  check('password', isSecretText, SECRET_ISSUE);
  if (problems.length > 0) fail(problems);
  // Stored lowercase (see the User model), so sign-in is case-insensitive too.
  return { kind: 'user', email: body.email.trim().toLowerCase(), password: body.password };
}

module.exports = { validateTokenRequest, BCRYPT_MAX_BYTES };
