const express = require('express');
const { issueUserToken, issueDeviceToken } = require('../services/auth-service');
const { validateTokenRequest } = require('../utils/validate-credentials');
const { jsonBody } = require('../middleware/json-body');
const { requireDatabase } = require('../middleware/require-database');
const { ApiError } = require('../utils/errors');

const router = express.Router();

// POST /auth/tokens creates a new token: a collection of tokens, and POST is its factory (201).
// No Location: a token is not stored, and no URL may ever return one. no-store keeps every
// cache from keeping a copy of the credential.
router.post('/', jsonBody, requireDatabase, async (req, res) => {
  const credentials = validateTokenRequest(req.body);
  // A person gets an analyst (or admin) token; a meter gets a token bound to its installation.
  const token = credentials.kind === 'device' ? await issueDeviceToken(credentials) : await issueUserToken(credentials);
  res.status(201).set('Cache-Control', 'no-store').json(token);
});

// Tokens can only be created. Each method listed on its own (not .all), so OPTIONS keeps
// Express's default handling. GET also covers HEAD.
function methodNotAllowed(req, res, next) {
  res.set('Allow', 'POST');
  next(new ApiError(405, 'METHOD_NOT_ALLOWED', `Tokens can only be created: ${req.method} is not allowed here. Allowed: POST.`));
}
router.route('/').get(methodNotAllowed).put(methodNotAllowed).patch(methodNotAllowed).delete(methodNotAllowed);

module.exports = router;
