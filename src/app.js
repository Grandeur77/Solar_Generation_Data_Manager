const express = require('express');
const healthRouter = require('./routes/health');

// Builds the app without listening, so tests can drive it with supertest.
const app = express();

app.use('/health', healthRouter);

module.exports = app;
