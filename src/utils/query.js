const { ApiError } = require('./errors');
const { parseInstant } = require('./iso-time');
const { sriLankaToday } = require('./sri-lanka-day');

// Query readers collect problems instead of throwing, so one 400 lists every bad value at once.
const detail = (field, issue) => ({ field, location: 'query', issue, reference: null });

// An optional id filter such as ?province-id=PV-01. A malformed value, or the parameter
// given twice, is a client error, not an empty result.
function readIdParam(query, name, pattern, example, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    problems.push(detail(name, `Must match ${example}, given once.`));
    return undefined;
  }
  return value;
}

// An optional value from a fixed list, e.g. ?status=active.
function readEnumParam(query, name, allowed, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    problems.push(detail(name, `Must be one of: ${allowed.join(', ')}, given once.`));
    return undefined;
  }
  return value;
}

// An optional plain decimal number ≥ min, e.g. ?min-power-kw=1.5. No exponents or signs.
function readNumberParam(query, name, min, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || Number(value) < min) {
    problems.push(detail(name, `Must be a number, ${min} or more, given once.`));
    return undefined;
  }
  return Number(value);
}

// An optional calendar day, e.g. ?date=2026-10-06: exactly YYYY-MM-DD, a day that exists
// (parseInstant rejects 30 February), and not after latest (also YYYY-MM-DD, so plain
// string comparison orders them correctly).
function readDateParam(query, name, latest, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseInstant(`${value}T00:00:00Z`)) {
    problems.push(detail(name, 'Must be a real calendar day as YYYY-MM-DD, given once.'));
    return undefined;
  }
  if (value > latest) {
    problems.push(detail(name, `Must not be after today in Sri Lanka (${latest}).`));
    return undefined;
  }
  return value;
}

// ?date= for the generation summaries: today in Sri Lanka when absent, 400 when invalid.
function readSummaryDate(query) {
  const today = sriLankaToday();
  const problems = [];
  const date = readDateParam(query, 'date', today, problems);
  throwIfInvalid(problems);
  return date || today;
}

function throwIfInvalid(problems) {
  if (problems.length > 0) {
    throw new ApiError(400, 'INVALID_QUERY_PARAMETER', 'One or more query parameters are invalid.', problems);
  }
}

module.exports = { readIdParam, readEnumParam, readNumberParam, readDateParam, readSummaryDate, throwIfInvalid };
