// Summaries work in Sri Lanka calendar days (Asia/Colombo). Sri Lanka is always UTC+05:30
// (no daylight saving), so a fixed offset is exact and every day is 24 hours long.
const OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The half-open window [00:00, next 00:00) Sri Lanka time for 'YYYY-MM-DD', as UTC instants.
// e.g. '2026-10-06' → [2026-10-05T18:30:00Z, 2026-10-06T18:30:00Z)
function sriLankaDay(date) {
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

// Today's date in Sri Lanka, 'YYYY-MM-DD'. Between 18:30Z and midnight UTC it is already tomorrow.
function sriLankaToday(now = new Date()) {
  return new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

module.exports = { sriLankaDay, sriLankaToday };
