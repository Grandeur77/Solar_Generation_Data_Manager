const express = require('express');
const { listDistricts, getDistrict } = require('../../services/district-service');
const { readIdParam, throwIfInvalid } = require('../../utils/query');
const { newest } = require('../../utils/http-cache');

const router = express.Router();

// ?province-id= narrows the collection. A well-formed id that matches nothing gives 200 [].
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  throwIfInvalid(problems);
  const districts = await listDistricts({ provinceId });
  res.locals.lastModified = newest(districts.map((d) => d.updated_at));
  res.json(districts);
});

router.get('/:districtId', async (req, res) => {
  const district = await getDistrict(req.params.districtId);
  res.locals.lastModified = district.updated_at;
  res.json(district);
});

module.exports = router;
