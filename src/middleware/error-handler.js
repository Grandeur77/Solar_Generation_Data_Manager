const { ApiError, errorBody } = require('../utils/errors');

const BEARER_CHALLENGE = 'Bearer realm="slsea-solar-api"';

// Registered after every route: nothing matched, so the path is not a resource of this API.
function unknownRoute(req, res, next) {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', `There is no resource at ${req.method} ${req.path}.`));
}

// Express recognises an error handler by its four arguments, so next must stay in the signature.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  // An error is never stored by a cache and replayed later.
  res.set('Cache-Control', 'no-store');
  if (err instanceof ApiError) {
    res.set(err.headers);
    // Every 401 must say how to authenticate. Set here, once, so no 401 can ever go without it.
    if (err.status === 401 && !res.get('WWW-Authenticate')) res.set('WWW-Authenticate', BEARER_CHALLENGE);
    return res.status(err.status).json(errorBody(err.code, err.message, err.details));
  }
  // Errors raised by express.json() while reading the request body.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(errorBody('INVALID_JSON', 'The request body is not valid JSON.'));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'The request body is larger than 100 KB.'));
  }
  // Anything unexpected: log it here, but never send internals (stack, query, driver message) to the client.
  console.error('Unhandled error:', err);
  return res.status(500).json(errorBody('INTERNAL_ERROR', 'Something went wrong on the server.'));
}

module.exports = { unknownRoute, errorHandler };
