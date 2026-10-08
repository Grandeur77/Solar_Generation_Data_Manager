const { ApiError, errorBody } = require('../utils/errors');

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
  if (err instanceof ApiError) {
    return res.status(err.status).json(errorBody(err.code, err.message, err.details));
  }
  // Anything unexpected: log it here, but never send internals (stack, query, driver message) to the client.
  console.error('Unhandled error:', err);
  return res.status(500).json(errorBody('INTERNAL_ERROR', 'Something went wrong on the server.'));
}

module.exports = { unknownRoute, errorHandler };
