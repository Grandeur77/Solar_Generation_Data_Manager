const { connectToDatabase } = require('../config/db');
const { ApiError } = require('../utils/errors');

// Data routes need a connection before they query. connectToDatabase() returns the cached
// connection after the first call, so this costs nothing on a warm instance.
async function requireDatabase(req, res, next) {
  try {
    await connectToDatabase();
    next();
  } catch (err) {
    console.error('Database unreachable:', err.message);
    next(new ApiError(503, 'SERVICE_UNAVAILABLE', 'The database cannot be reached.'));
  }
}

module.exports = { requireDatabase };
