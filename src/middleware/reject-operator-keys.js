const { ApiError } = require('../utils/errors');

// NoSQL-injection guard. A key containing "$" ({"email": {"$ne": null}}, or "status[$ne]" in a
// query string) or "." is how a request smuggles a MongoDB operator or a nested path into a query.
// No field of this API has either character in its name, so a request containing one is refused
// (400) before any query is built, rather than silently cleaned. The validators also check every
// type; this is the second line of defence.
const isOperatorKey = (key) => key.includes('$') || key.includes('.');
const issue = 'Keys containing $ or . are not accepted.';

function findOperatorKeys(value, path, found) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findOperatorKeys(item, `${path}[${i}]`, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isOperatorKey(key)) found.push(childPath);
      findOperatorKeys(child, childPath, found);
    }
  }
}

const refuse = (problems) => new ApiError(400, 'VALIDATION_FAILED', 'The request contains keys that are not allowed.', problems);

// For JSON bodies (part of jsonBody, after parsing).
function rejectOperatorKeysInBody(req, res, next) {
  const found = [];
  findOperatorKeys(req.body, '', found);
  if (found.length > 0) return next(refuse(found.map((field) => ({ field, location: 'body', issue, reference: null }))));
  return next();
}

// For every request's query string. Express's simple parser keeps "status[$ne]" as one plain key
// (the $ is in the middle), which is why the check is "contains", not "starts with".
function rejectOperatorKeysInQuery(req, res, next) {
  const found = Object.keys(req.query).filter(isOperatorKey);
  if (found.length > 0) return next(refuse(found.map((field) => ({ field, location: 'query', issue, reference: null }))));
  return next();
}

module.exports = { rejectOperatorKeysInBody, rejectOperatorKeysInQuery };
