const mongoose = require('mongoose');

// Module scope survives between requests on a warm serverless instance, so this one
// promise is shared by every request: the first caller starts the connection, later
// and concurrent callers await the same promise instead of opening another.
let connectPromise = null;

function connectToDatabase() {
  if (!connectPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      return Promise.reject(new Error('MONGODB_URI is not set'));
    }

    connectPromise = mongoose
      .connect(uri, {
        // Fail in 5 s instead of the 30 s default, well inside the function time limit.
        serverSelectionTimeoutMS: 5000,
        // Each serverless instance keeps its own pool; a small cap keeps many instances
        // well under the free M0 cluster's connection limit.
        maxPoolSize: 10,
      })
      .then((m) => m.connection)
      .catch((err) => {
        // Forget the failed attempt so the next request can try again.
        connectPromise = null;
        throw err;
      });
  }
  return connectPromise;
}

module.exports = { connectToDatabase };
