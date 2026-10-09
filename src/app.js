const express = require('express');
const helmet = require('helmet');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const docsRouter = require('./routes/docs');
const provincesRouter = require('./routes/read/provinces');
const districtsRouter = require('./routes/read/districts');
const gridSubstationsRouter = require('./routes/read/grid-substations');
const installationsRouter = require('./routes/read/installations');
const readingsWriteRouter = require('./routes/write/readings');
const installationsWriteRouter = require('./routes/write/installations');
const { acceptJson } = require('./middleware/accept-json');
const { authenticate } = require('./middleware/authenticate');
const { requireReadScope } = require('./middleware/authorize');
const { corsPolicy } = require('./middleware/cors-policy');
const { privateCaching } = require('./middleware/private-caching');
const { rejectOperatorKeysInQuery } = require('./middleware/reject-operator-keys');
const { requireDatabase } = require('./middleware/require-database');
const { conditionalGet } = require('./middleware/conditional-get');
const { unknownRoute, errorHandler } = require('./middleware/error-handler');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();
// On Vercel every request arrives through one proxy, which puts the real client address in
// X-Forwarded-For. Trusting exactly that one hop gives the rate limiter the client's address
// instead of the proxy's. Locally there is no proxy, so the header is not trusted (it could be faked).
app.set('trust proxy', process.env.VERCEL ? 1 : false);
// Express's automatic weak ETag is replaced by the strong ETags of conditionalGet (and of writes),
// and must never appear on error responses.
app.set('etag', false);
// Express would also turn a GET into 304 on its own when its freshness check passes (e.g.
// If-None-Match: * on /health). 304 is decided only by conditionalGet, so that check is switched off.
app.use((req, res, next) => {
  Object.defineProperty(req, 'fresh', { value: false });
  next();
});

// Security headers on every response: no X-Powered-By, nosniff, HSTS, a strict
// Content-Security-Policy (the docs page sets its own, a little wider), and more.
app.use(helmet());
// Before authentication, so an allowed browser's preflight (which carries no token) is answered.
app.use(corsPolicy);
app.use(rejectOperatorKeysInQuery);

// The docs page is HTML and the spec is YAML, so they sit before the JSON-only check.
app.use('/api-docs', docsRouter);

// Every resource of the API needs a bearer token. Registered once, here, in front of every route
// under these paths and before anything else looks at the request, so an unauthenticated caller
// gets 401 and learns nothing else: not whether an id exists (404), which methods a URI allows
// (405), or anything about its Accept header (406). /health, /api-docs and /auth/tokens stay
// public, and a path that is no resource at all is still 404.
app.use(['/provinces', '/districts', '/grid-substations', '/installations'], privateCaching, authenticate);

app.use(acceptJson);
app.use('/health', healthRouter);
// Public on purpose: it is how a client gets a token in the first place. Above conditionalGet
// because a token response must never get an ETag or a 304.
app.use('/auth/tokens', authRouter);

// Every GET below gets a strong ETag, Last-Modified and 304 support. /health is above on purpose:
// it must always be checked live, never answered from a cached copy.
app.use(conditionalGet);

// Write path. Kept in its own router so the write-read split is visible in the code.
// It connects to the database per route, and sits before the read routers (which connect for
// every request they see), so its 405 answers need no database. GETs pass straight through it.
app.use('/installations', readingsWriteRouter);
app.use('/installations', installationsWriteRouter);

// Read path: every GET needs the analyst read scope (a meter's token is refused with 403).
// Jurisdiction filtering is added in Step 9.6.
app.use('/provinces', requireReadScope, requireDatabase, provincesRouter);
app.use('/districts', requireReadScope, requireDatabase, districtsRouter);
app.use('/grid-substations', requireReadScope, requireDatabase, gridSubstationsRouter);
app.use('/installations', requireReadScope, requireDatabase, installationsRouter);

// Must stay last: unmatched paths, then every error, become the standard error body.
app.use(unknownRoute);
app.use(errorHandler);

module.exports = app;
