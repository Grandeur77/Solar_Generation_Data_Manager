const express = require('express');
const { listGridSubstations, getGridSubstation } = require('../../services/grid-substation-service');
const { readIdParam, throwIfInvalid } = require('../../utils/query');

const router = express.Router();

// Filters combine (AND); every malformed filter is reported in one 400.
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  const districtId = readIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01', problems);
  throwIfInvalid(problems);
  res.json(await listGridSubstations({ provinceId, districtId }));
});

router.get('/:substationId', async (req, res) => {
  res.json(await getGridSubstation(req.params.substationId));
});

module.exports = router;
