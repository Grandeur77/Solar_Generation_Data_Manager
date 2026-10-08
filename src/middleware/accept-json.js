const { ApiError } = require('../utils/errors');

// Every API resource is application/json only. A client whose Accept header rules JSON out
// gets 406. No Accept header, */* and application/* all accept JSON, so they pass.
function acceptJson(req, res, next) {
  if (!req.accepts('json')) {
    return next(new ApiError(406, 'NOT_ACCEPTABLE', 'This API only produces application/json.'));
  }
  return next();
}

module.exports = { acceptJson };
