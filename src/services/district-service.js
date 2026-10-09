const District = require('../models/district');
const { notFound } = require('../utils/errors');
const { districtFilter, checkFilter, checkMember } = require('./jurisdiction-service');

// provinceId is optional; when given it narrows the collection (a filter, not a scope). It must
// overlap the caller's jurisdiction (403 otherwise), and the result is always cut to it.
// $and keeps the two conditions apart, so one can never overwrite the other.
async function listDistricts({ provinceId } = {}, auth) {
  if (provinceId) await checkFilter(auth, 'province', provinceId, 'province-id');
  const conditions = [districtFilter(auth)];
  if (provinceId) conditions.push({ province_id: provinceId });
  return District.find({ $and: conditions }).sort({ _id: 1 });
}

// 404 if it doesn't exist, then 403 if it is outside the caller's jurisdiction.
async function getDistrict(districtId, auth) {
  const district = await District.findById(districtId);
  if (!district) throw notFound('DISTRICT_NOT_FOUND', `No district with id ${districtId}.`);
  checkMember(auth, { province_id: district.province_id, district_id: districtId }, 'district', 'district-id');
  return district;
}

// For resources under /districts/{district-id}/: the same two checks.
async function ensureDistrictReadable(districtId, auth) {
  await getDistrict(districtId, auth);
}

module.exports = { listDistricts, getDistrict, ensureDistrictReadable };
