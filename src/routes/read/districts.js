const express = require('express');
const { listDistricts, getDistrict } = require('../../services/district-service');
const { readIdParam, throwIfInvalid } = require('../../utils/query');

const router = express.Router();

// ?province-id= narrows the collection. A well-formed id that matches nothing gives 200 [].
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  throwIfInvalid(problems);
  res.json(await listDistricts({ provinceId }));
});

router.get('/:districtId', async (req, res) => {
  res.json(await getDistrict(req.params.districtId));
});

module.exports = router;
