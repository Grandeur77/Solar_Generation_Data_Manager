const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const router = express.Router();

// Read once at startup. vercel.json's includeFiles makes sure the file is in the serverless bundle.
const spec = fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.yaml'), 'utf8');

// Assets come from a pinned CDN version because swagger-ui-express's local asset files are not
// reliably included in Vercel's bundle. The integrity hashes make the browser reject altered files.
const CDN = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1';
const CSS_SRI = 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW';
const JS_SRI = 'sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw';

const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SLSEA Solar Generation API docs</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="${CDN}/swagger-ui.css" integrity="${CSS_SRI}" crossorigin="anonymous">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${CDN}/swagger-ui-bundle.js" integrity="${JS_SRI}" crossorigin="anonymous"></script>
  <script src="/api-docs/init.js"></script>
</body>
</html>`;

// The start-up script is a file of our own rather than an inline <script>, so the page's
// Content-Security-Policy can forbid inline scripts entirely.
const init = "window.ui = SwaggerUIBundle({ url: '/api-docs/openapi', dom_id: '#swagger-ui' });\n";

// The JSON API gets helmet's strict default policy (app.js). This page needs a little more: scripts
// and styles from our own origin and the pinned CDN only (Swagger UI also sets inline styles), and
// its icons are data: images. Nothing else may load.
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';
router.use(
  helmet.contentSecurityPolicy({
    useDefaults: true,
    directives: {
      scriptSrc: ["'self'", CDN_ORIGIN],
      styleSrc: ["'self'", CDN_ORIGIN, "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  })
);

router.get('/init.js', (req, res) => {
  res.type('application/javascript').send(init);
});

// The spec is YAML, not JSON, so it is sent with its own media type instead of res.json().
router.get('/openapi', (req, res) => {
  res.type('application/yaml').send(spec);
});

router.get('/', (req, res) => {
  res.type('html').send(page);
});

module.exports = router;
