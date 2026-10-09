const { ApiError } = require('./errors');
const { parseInstant } = require('./iso-time');

const detail = (field, issue) => ({ field, location: 'query', issue, reference: null });

// In a query string "+" means a space, so an unencoded "+05:30" arrives as " 05:30".
// Putting the "+" back is what the client meant; otherwise every curl/Postman user would hit a 400.
const restorePlus = (text) => text.replace(/ (\d{2}:\d{2})$/, '+$1');

function instantParam(query, name, problems) {
  const value = query[name];
  if (value === undefined) return undefined;
  const instant = typeof value === 'string' ? parseInstant(restorePlus(value)) : null;
  if (!instant) {
    problems.push(detail(name, 'Must be one ISO-8601 date-time with a time zone, e.g. 2026-10-05T00:00:00+05:30 or 2026-10-04T18:30:00Z.'));
  }
  return instant || undefined;
}

// Reads ?from= and ?to= (adding format problems to `problems`). The window is half-open,
// [from, to): from is inclusive and to exclusive, so consecutive windows never count a reading twice.
function readTimeWindow(query, problems) {
  return { from: instantParam(query, 'from', problems), to: instantParam(query, 'to', problems) };
}

// Called once both values are known to be well-formed: from must be strictly earlier than to.
// An equal pair describes an empty window, which is almost always a client mistake.
function checkTimeWindowOrder({ from, to }) {
  if (from && to && from.getTime() >= to.getTime()) {
    throw new ApiError(400, 'INVALID_TIME_WINDOW', 'from must be earlier than to.', [
      detail('from', `Must be earlier than to (${to.toISOString()}).`),
      detail('to', `Must be later than from (${from.toISOString()}).`),
    ]);
  }
}

// The MongoDB condition on the measurement time, or null when no bound is given.
function timestampCondition({ from, to }) {
  if (!from && !to) return null;
  const condition = {};
  if (from) condition.$gte = from;
  if (to) condition.$lt = to;
  return condition;
}

module.exports = { readTimeWindow, checkTimeWindowOrder, timestampCondition };
