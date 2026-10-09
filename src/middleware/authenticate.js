const { ApiError } = require('../utils/errors');
const { verifyToken } = require('../utils/tokens');

const REALM = 'Bearer realm="slsea-solar-api"';
// "Bearer" followed by the token. The scheme name is case-insensitive in HTTP.
const BEARER = /^Bearer[ ]+(\S+)$/i;

// No usable credentials at all: the challenge only says which scheme to use.
const authenticationRequired = () => new ApiError(401, 'AUTHENTICATION_REQUIRED', 'A bearer token is required.');

// A token was sent but is not acceptable: the challenge says so (error="invalid_token"), so a
// client can tell "sign in again" from "you never signed in".
function rejected(code, message, description) {
  return new ApiError(401, code, message, [], {
    'WWW-Authenticate': `${REALM}, error="invalid_token", error_description="${description}"`,
  });
}

// Registered in app.js in front of every route it guards. Only proves WHO is calling: what the
// caller may do (scope, installation, jurisdiction) is checked later, on each route.
function authenticate(req, res, next) {
  const header = req.get('Authorization');
  const match = header && BEARER.exec(header.trim());
  // Missing, empty, or another scheme such as Basic: there is no bearer token to check.
  if (!match) return next(authenticationRequired());

  let claims;
  try {
    claims = verifyToken(match[1]);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(rejected('TOKEN_EXPIRED', 'The token has expired; request a new one.', 'The token has expired'));
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return next(rejected('INVALID_TOKEN', 'The token is not valid.', 'The token is not valid'));
    }
    return next(err); // e.g. no signing secret configured: a server fault (500), not the client's
  }

  // jsonwebtoken accepts a correctly signed token with no exp, which would never expire. Every
  // token this API issues has exp, sub and scope, so anything without them is not one of ours.
  if (typeof claims.exp !== 'number' || typeof claims.sub !== 'string' || typeof claims.scope !== 'string') {
    return next(rejected('INVALID_TOKEN', 'The token is not valid.', 'The token is not valid'));
  }

  // What the route checks need, in plain names.
  req.auth = {
    subject: claims.sub,
    scopes: claims.scope.split(' '),
    jurisdiction: claims.jurisdiction || null,
    tokenId: claims.jti,
  };
  return next();
}

module.exports = { authenticate };
