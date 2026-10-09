const { ApiError } = require('../utils/errors');

// A generation summary is worked out from readings on request: there is nothing to create,
// replace or delete. 405 (not 404) says the resource exists but the method is wrong, and
// Allow lists what is permitted.
const ALLOW = 'GET, HEAD';

function summaryMethodNotAllowed(req, res, next) {
  res.set('Allow', ALLOW);
  next(new ApiError(405, 'METHOD_NOT_ALLOWED', `A generation summary is read-only: ${req.method} is not allowed here. Allowed: ${ALLOW}.`));
}

module.exports = { summaryMethodNotAllowed };
