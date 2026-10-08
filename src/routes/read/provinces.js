const express = require('express');
const { listProvinces, getProvince } = require('../../services/province-service');

const router = express.Router();

// An empty collection is 200 with [], never 404.
router.get('/', async (req, res) => {
  res.json(await listProvinces());
});

router.get('/:provinceId', async (req, res) => {
  res.json(await getProvince(req.params.provinceId));
});

module.exports = router;
