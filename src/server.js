const app = require('./app');

// Render injects PORT at runtime; 3000 is only the local default.
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Solar API listening on port ${PORT}`);
});
