const express = require('express');
const healthRouter = require('./routes/health');
const docsRouter = require('./routes/docs');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();

app.use('/health', healthRouter);
app.use('/api-docs', docsRouter);

module.exports = app;
