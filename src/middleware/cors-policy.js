const cors = require('cors');

// Restricted CORS. The API is used by meters and server-side clients, which don't send Origin and
// aren't affected by CORS at all. Browsers are allowed only from origins listed in CORS_ORIGINS
// (comma-separated, exact match); by default none, so no web page on another site can call the
// API from a visitor's browser. Bearer tokens, not cookies, so credentials stay off.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsPolicy = cors({
  origin: (origin, callback) => callback(null, origin !== undefined && allowedOrigins.includes(origin)),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'If-Match', 'If-None-Match', 'If-Modified-Since'],
  // Headers a browser script may read; without this it could not see an ETag or Location.
  exposedHeaders: ['ETag', 'Last-Modified', 'Location', 'Retry-After', 'WWW-Authenticate', 'Allow'],
  credentials: false,
  maxAge: 600,
});

module.exports = { corsPolicy, allowedOrigins };
