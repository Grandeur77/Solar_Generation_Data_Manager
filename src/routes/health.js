const express = require('express');
const { log } = require('../utils/logger');
const { connectToDatabase } = require('../config/db');
const { errorBody } = require('../utils/errors');

const router = express.Router();

// Liveness check for the hosting platform and smoke tests, including whether the database answers.
router.get('/', async (req, res) => {
  // Health must always reflect the live state, so no cache may store it.
  res.set('Cache-Control', 'no-store');
  try {
    const connection = await connectToDatabase();
    // A ping proves the database answers now, not just that a connection was opened earlier.
    await connection.db.admin().command({ ping: 1 });
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    // Log the cause server-side only; the client never sees connection details.
    log('error', { request_id: req.id, event: 'health_database_unreachable', message: err.message });
    res.status(503).json(errorBody('SERVICE_UNAVAILABLE', 'The database cannot be reached.'));
  }
});

module.exports = router;
