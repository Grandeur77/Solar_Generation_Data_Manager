const Province = require('../models/province');
const { notFound } = require('../utils/errors');

// Documents, not .lean(): the model's toJSON turns _id into province_id and drops __v.
async function listProvinces() {
  return Province.find().sort({ _id: 1 });
}

async function getProvince(provinceId) {
  const province = await Province.findById(provinceId);
  if (!province) throw notFound('PROVINCE_NOT_FOUND', `No province with id ${provinceId}.`);
  return province;
}

module.exports = { listProvinces, getProvince };
