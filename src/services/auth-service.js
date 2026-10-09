const bcrypt = require('bcryptjs');
const User = require('../models/user');
const SolarInstallation = require('../models/solar-installation');
const { ApiError } = require('../utils/errors');
const { SCOPES, LIFETIME_SECONDS, signToken } = require('../utils/tokens');

// Compared against when the email or meter is unknown, at the same cost as real hashes, so the
// response takes about as long either way and its timing doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

const invalidCredentials = () => new ApiError(401, 'INVALID_CREDENTIALS', 'The credentials are not valid.');

// The user's single jurisdiction, as the token carries it (national has no id).
function jurisdictionOf(user) {
  if (user.jurisdiction_level === 'province') return { level: 'province', id: user.province_id };
  if (user.jurisdiction_level === 'district') return { level: 'district', id: user.district_id };
  return { level: 'national', id: null };
}

// Email + password → a signed token for an SLSEA user or the registry admin.
async function issueUserToken({ email, password }) {
  const user = await User.findOne({ email }).select('+password_hash');
  // Always run bcrypt, even for an unknown email, and give one answer for both failures.
  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordMatches) throw invalidCredentials();
  // Only after the password is proven, so this reveals nothing to someone guessing.
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'This account is inactive.');

  // The admin also reads everything (data-model §5), so it gets both scopes; the shorter
  // admin lifetime applies because of what the token can change.
  const isAdmin = user.role === 'registry_admin';
  const scope = isAdmin ? `${SCOPES.ASSET_ADMIN} ${SCOPES.ANALYST_READ}` : SCOPES.ANALYST_READ;
  const lifetimeSeconds = LIFETIME_SECONDS[isAdmin ? SCOPES.ASSET_ADMIN : SCOPES.ANALYST_READ];

  const accessToken = signToken({ subject: user._id, claims: { scope, jurisdiction: jurisdictionOf(user) }, lifetimeSeconds });
  return { access_token: accessToken, token_type: 'Bearer', expires_in: lifetimeSeconds, scope };
}

// meter_id + device secret → an installation-write token bound to that installation (its sub).
// The token carries no jurisdiction: a meter reads nothing, it only adds readings for itself.
async function issueDeviceToken({ meter_id: meterId, device_secret: deviceSecret }) {
  const installation = await SolarInstallation.findOne({ meter_id: meterId }).select('+device_secret_hash');
  // An installation registered through the API has no secret yet; its meter can't sign in, and
  // gets the same 401 as an unknown meter (bcrypt would throw on a missing hash).
  const hash = installation && installation.device_secret_hash;
  const secretMatches = await bcrypt.compare(deviceSecret, hash || DUMMY_HASH);
  if (!hash || !secretMatches) throw invalidCredentials();
  if (installation.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'This installation is inactive.');

  const scope = SCOPES.INSTALLATION_WRITE;
  const lifetimeSeconds = LIFETIME_SECONDS[scope];
  const accessToken = signToken({ subject: installation._id, claims: { scope }, lifetimeSeconds });
  return { access_token: accessToken, token_type: 'Bearer', expires_in: lifetimeSeconds, scope };
}

module.exports = { issueUserToken, issueDeviceToken };
