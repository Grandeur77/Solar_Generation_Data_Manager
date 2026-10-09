const { ApiError } = require('./errors');

// sort=<field> is ascending and sort=-<field> descending, with the field written exactly as in the JSON.
// Exactly one field per request; anything else is a 400 that lists what is allowed.
function readSort(query, allowedFields, defaultSort) {
  const value = query.sort;
  if (value === undefined) return defaultSort;

  const field = typeof value === 'string' && value.startsWith('-') ? value.slice(1) : value;
  if (typeof value !== 'string' || !allowedFields.includes(field)) {
    throw new ApiError(400, 'INVALID_SORT_FIELD', 'The sort field is not supported.', [
      {
        field: 'sort',
        location: 'query',
        issue: 'Use one allowed field, prefixed with - for descending, given once.',
        reference: allowedFields.join(', '),
      },
    ]);
  }
  return value;
}

// The MongoDB sort for a value such as "-power_kw". Equal values are ordered by a unique
// tie-breaker field, so the order is the same on every request and pages never repeat or skip
// items. Readings break ties newest first (-1); installations by id ascending (1).
// storedNames maps a JSON field to its stored name where they differ (installation_id is stored
// as _id): sorting on a name that isn't stored would silently sort on nothing.
function mongoSort(sortValue, tieBreaker, tieDirection = -1, storedNames = {}) {
  const descending = sortValue.startsWith('-');
  const jsonField = descending ? sortValue.slice(1) : sortValue;
  const field = storedNames[jsonField] || jsonField;
  const order = { [field]: descending ? -1 : 1 };
  if (field !== tieBreaker) order[tieBreaker] = tieDirection;
  return order;
}

module.exports = { readSort, mongoSort };
