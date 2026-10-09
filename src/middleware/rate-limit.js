const { rateLimit } = require('express-rate-limit');
const { ApiError } = require('../utils/errors');

// Brute-force protection for POST /auth/tokens: at most MAX_FAILURES failed attempts (wrong
// credentials, inactive account, bad body) per client address in WINDOW_MS. Successful sign-ins
// don't count, so meters re-authenticating every day and analysts signing in are never slowed down;
// only guessing is. Configurable for operations and tests; 10 per 15 minutes by default.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = Number(process.env.AUTH_TOKEN_MAX_FAILURES) || 10;

// Limitation (report): the counts live in this process's memory. On serverless hosting each
// instance counts separately, so the real limit is per instance; a shared store would fix that.
const tokenRequestLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_FAILURES,
  skipSuccessfulRequests: true,
  standardHeaders: false,
  legacyHeaders: false,
  // Our own 429: the standard error body, and Retry-After saying how many seconds to wait.
  handler: (req, res, next) => {
    const seconds = Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
    next(
      new ApiError(429, 'TOO_MANY_REQUESTS', `Too many failed attempts. Try again in ${seconds} seconds.`, [], {
        'Retry-After': String(seconds),
      })
    );
  },
});

module.exports = { tokenRequestLimiter, MAX_FAILURES, WINDOW_MS };
