const app = require('./app');

// Local runs only; on Vercel, api/index.js serves the app and this file never runs.
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Solar API listening on port ${PORT}`);
});
