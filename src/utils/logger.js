// Structured logging: one JSON object per line on stdout (errors on stderr), which Vercel's log
// viewer and any log tool can search by field. Only the fields passed in are written, and callers
// never pass headers or bodies, so a token, password or device secret has no way into a log line.
//
// On by default; off under Jest (NODE_ENV=test) so test output stays readable. LOG_REQUESTS=true or
// false overrides either way.
const enabled = () => (process.env.LOG_REQUESTS ? process.env.LOG_REQUESTS === 'true' : process.env.NODE_ENV !== 'test');

function log(level, fields) {
  if (!enabled()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

module.exports = { log };
