const express = require('express');
const healthRouter = require('./routes/health');
const docsRouter = require('./routes/docs');
const provincesRouter = require('./routes/read/provinces');
const districtsRouter = require('./routes/read/districts');
const gridSubstationsRouter = require('./routes/read/grid-substations');
const installationsRouter = require('./routes/read/installations');
const { acceptJson } = require('./middleware/accept-json');
const { requireDatabase } = require('./middleware/require-database');
const { unknownRoute, errorHandler } = require('./middleware/error-handler');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();

// The docs page is HTML and the spec is YAML, so they sit before the JSON-only check.
app.use('/api-docs', docsRouter);

app.use(acceptJson);
app.use('/health', healthRouter);

// Read path. Authentication and jurisdiction filtering are added in the security phase.
app.use('/provinces', requireDatabase, provincesRouter);
app.use('/districts', requireDatabase, districtsRouter);
app.use('/grid-substations', requireDatabase, gridSubstationsRouter);
app.use('/installations', requireDatabase, installationsRouter);

// Must stay last: unmatched paths, then every error, become the standard error body.
app.use(unknownRoute);
app.use(errorHandler);

module.exports = app;
