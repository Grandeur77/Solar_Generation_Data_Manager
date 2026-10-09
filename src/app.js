const express = require('express');
const healthRouter = require('./routes/health');
const docsRouter = require('./routes/docs');
const provincesRouter = require('./routes/read/provinces');
const districtsRouter = require('./routes/read/districts');
const gridSubstationsRouter = require('./routes/read/grid-substations');
const installationsRouter = require('./routes/read/installations');
const readingsWriteRouter = require('./routes/write/readings');
const { acceptJson } = require('./middleware/accept-json');
const { requireDatabase } = require('./middleware/require-database');
const { unknownRoute, errorHandler } = require('./middleware/error-handler');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();

// The docs page is HTML and the spec is YAML, so they sit before the JSON-only check.
app.use('/api-docs', docsRouter);

app.use(acceptJson);
app.use('/health', healthRouter);

// Write path. Kept in its own router so the write-read split is visible in the code.
// It connects to the database per route, and sits before the read routers (which connect for
// every request they see), so its 405 answers need no database. GETs pass straight through it.
app.use('/installations', readingsWriteRouter);

// Read path. Authentication and jurisdiction filtering are added in the security phase.
app.use('/provinces', requireDatabase, provincesRouter);
app.use('/districts', requireDatabase, districtsRouter);
app.use('/grid-substations', requireDatabase, gridSubstationsRouter);
app.use('/installations', requireDatabase, installationsRouter);

// Must stay last: unmatched paths, then every error, become the standard error body.
app.use(unknownRoute);
app.use(errorHandler);

module.exports = app;
