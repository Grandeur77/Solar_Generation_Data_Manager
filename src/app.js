const express = require('express');
const healthRouter = require('./routes/health');
const docsRouter = require('./routes/docs');
const provincesRouter = require('./routes/read/provinces');
const districtsRouter = require('./routes/read/districts');
const gridSubstationsRouter = require('./routes/read/grid-substations');
const installationsRouter = require('./routes/read/installations');
const readingsWriteRouter = require('./routes/write/readings');
const installationsWriteRouter = require('./routes/write/installations');
const { acceptJson } = require('./middleware/accept-json');
const { requireDatabase } = require('./middleware/require-database');
const { conditionalGet } = require('./middleware/conditional-get');
const { unknownRoute, errorHandler } = require('./middleware/error-handler');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();
// Express's automatic weak ETag is replaced by the strong ETags of conditionalGet (and of writes),
// and must never appear on error responses.
app.set('etag', false);
// Express would also turn a GET into 304 on its own when its freshness check passes (e.g.
// If-None-Match: * on /health). 304 is decided only by conditionalGet, so that check is switched off.
app.use((req, res, next) => {
  Object.defineProperty(req, 'fresh', { value: false });
  next();
});

// The docs page is HTML and the spec is YAML, so they sit before the JSON-only check.
app.use('/api-docs', docsRouter);

app.use(acceptJson);
app.use('/health', healthRouter);

// Every GET below gets a strong ETag, Last-Modified and 304 support. /health is above on purpose:
// it must always be checked live, never answered from a cached copy.
app.use(conditionalGet);

// Write path. Kept in its own router so the write-read split is visible in the code.
// It connects to the database per route, and sits before the read routers (which connect for
// every request they see), so its 405 answers need no database. GETs pass straight through it.
app.use('/installations', readingsWriteRouter);
app.use('/installations', installationsWriteRouter);

// Read path. Authentication and jurisdiction filtering are added in the security phase.
app.use('/provinces', requireDatabase, provincesRouter);
app.use('/districts', requireDatabase, districtsRouter);
app.use('/grid-substations', requireDatabase, gridSubstationsRouter);
app.use('/installations', requireDatabase, installationsRouter);

// Must stay last: unmatched paths, then every error, become the standard error body.
app.use(unknownRoute);
app.use(errorHandler);

module.exports = app;
