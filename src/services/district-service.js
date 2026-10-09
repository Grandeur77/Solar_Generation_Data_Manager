const District = require('../models/district');
const { notFound } = require('../utils/errors');

// provinceId is optional; when given it narrows the collection (a filter, not a scope).
async function listDistricts({ provinceId } = {}) {
  const filter = provinceId ? { province_id: provinceId } : {};
  return District.find(filter).sort({ _id: 1 });
}

async function getDistrict(districtId) {
  const district = await District.findById(districtId);
  if (!district) throw notFound('DISTRICT_NOT_FOUND', `No district with id ${districtId}.`);
  return district;
}

// For resources under /districts/{district-id}/: checks the id without loading the district.
async function ensureDistrictExists(districtId) {
  if (!(await District.exists({ _id: districtId }))) {
    throw notFound('DISTRICT_NOT_FOUND', `No district with id ${districtId}.`);
  }
}

module.exports = { listDistricts, getDistrict, ensureDistrictExists };
