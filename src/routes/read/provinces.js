const express = require('express');
const { listProvinces, getProvince } = require('../../services/province-service');

const router = express.Router();

// An empty collection is 200 with [], never 404.
router.get('/', async (req, res) => {
  const provinces = await listProvinces();
  res.json(provinces);
});

router.get('/:provinceId', async (req, res) => {
  const province = await getProvince(req.params.provinceId);
  res.locals.lastModified = province.updated_at;
  res.json(province);
});

module.exports = router;
