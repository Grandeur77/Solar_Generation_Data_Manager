const { ApiError } = require('./errors');

// Reads an optional id filter such as ?province-id=PV-01. Missing → undefined.
// A malformed value, or the same parameter given twice, is a client error (400), not an empty result.
function optionalIdParam(query, name, pattern, example) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ApiError(400, 'INVALID_QUERY_PARAMETER', `${name} must be a single id like ${example}.`, [
      { field: name, location: 'query', issue: `Must match ${example}.`, reference: null },
    ]);
  }
  return value;
}

module.exports = { optionalIdParam };
