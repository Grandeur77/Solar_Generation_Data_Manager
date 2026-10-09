const crypto = require('crypto');
const { log } = require('../utils/logger');

// A caller (or a proxy in front of us) may send its own X-Request-Id to follow one request across
// systems. It is kept only if it is short and made of safe characters, so it can never inject a
// line break, a quote or a fake field into a log line; otherwise a new id is made. It is for
// matching log lines and support questions only, never for security.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// Anything in a path that looks like a JWT (a client pasting a token in the wrong place) is
// replaced before the path is logged.
const JWT_LIKE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

// First middleware: every response, errors and 304s included, carries the id in X-Request-Id, and
// exactly one log line is written when the response has been sent.
function requestContext(req, res, next) {
  const incoming = req.get('X-Request-Id');
  req.id = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const fields = {
      request_id: req.id,
      method: req.method,
      // The path only: the query string is never logged, and token-shaped segments are redacted.
      path: req.originalUrl.split('?')[0].replace(JWT_LIKE, '[redacted]').slice(0, 300),
      status: res.statusCode,
      duration_ms: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)),
    };
    // Who made the request (set only after the token was verified): the id and scope, never the token.
    if (req.auth) {
      fields.subject = req.auth.subject;
      fields.scope = req.auth.scopes.join(' ');
    }
    log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', fields);
  });
  next();
}

module.exports = { requestContext };
