const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Token design: docs (api-surface §15). iss names who signs (this token endpoint) and aud names
// who must accept (this API's routes); verification will check both, so a token made for anything
// else is refused even if it was signed with the same secret.
const ISSUER = 'slsea-solar-api/auth';
const AUDIENCE = 'slsea-solar-api';
const ALGORITHM = 'HS256';

const SCOPES = {
  INSTALLATION_WRITE: 'installation-write',
  ANALYST_READ: 'analyst-read-by-jurisdiction',
  ASSET_ADMIN: 'asset-admin',
};

// Shorter where a leaked token could do more harm.
const LIFETIME_SECONDS = {
  [SCOPES.INSTALLATION_WRITE]: 24 * 60 * 60,
  [SCOPES.ANALYST_READ]: 60 * 60,
  [SCOPES.ASSET_ADMIN]: 15 * 60,
};

// Read when a token is signed, not when the module loads, so a missing secret fails loudly on
// first use instead of the app signing with undefined. A short secret is refused outright.
function signingSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to at least 32 characters');
  }
  return secret;
}

// claims: what the token says beyond the standard fields, e.g. { scope, jurisdiction }.
function signToken({ subject, claims, lifetimeSeconds }) {
  return jwt.sign(claims, signingSecret(), {
    algorithm: ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE,
    subject,
    expiresIn: lifetimeSeconds,
    // Every token is distinct (two identical sign-ins give two tokens) and traceable in logs.
    jwtid: crypto.randomUUID(),
  });
}

module.exports = { ISSUER, AUDIENCE, ALGORITHM, SCOPES, LIFETIME_SECONDS, signToken };
