const express = require('express');

const router = express.Router();

// Liveness check for the hosting platform and smoke tests.
router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;
