// ISO-8601 date-time that states its time zone (Z or +05:30), so the instant is unambiguous:
// UTC and Sri Lanka time differ by 5½ hours. A date on its own, or a time without a zone, is refused.
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Returns a Date, or null when the text isn't a real date-time with a time zone.
function parseInstant(text) {
  if (typeof text !== 'string') return null;
  const match = ISO_WITH_ZONE.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second = 0] = match.slice(1, 7).map((part) => (part === undefined ? undefined : Number(part)));

  // JavaScript silently rolls impossible values over (30 February becomes 2 March), so check that
  // the calendar date and the time of day really exist before trusting Date.parse.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const realDate = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  const realTime = hour <= 23 && minute <= 59 && second <= 59;
  if (!realDate || !realTime) return null;

  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

module.exports = { parseInstant, ISO_WITH_ZONE };
