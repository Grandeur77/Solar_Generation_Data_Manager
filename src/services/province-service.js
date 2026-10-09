const Province = require('../models/province');
const { notFound } = require('../utils/errors');
const { provinceFilter, checkMember } = require('./jurisdiction-service');

// Every function takes auth (req.auth from the token): the caller only ever gets what their
// jurisdiction allows, and the filter is part of the database query.

// Documents, not .lean(): the model's toJSON turns _id into province_id and drops __v.
async function listProvinces(auth) {
  return Province.find(provinceFilter(auth)).sort({ _id: 1 });
}

// 404 if it doesn't exist, then 403 if it is outside the caller's jurisdiction.
async function getProvince(provinceId, auth) {
  const province = await Province.findById(provinceId);
  if (!province) throw notFound('PROVINCE_NOT_FOUND', `No province with id ${provinceId}.`);
  checkMember(auth, { province_id: provinceId, district_id: null }, 'province', 'province-id');
  return province;
}

// For resources under /provinces/{province-id}/: the same two checks without loading the province.
async function ensureProvinceReadable(provinceId, auth) {
  if (!(await Province.exists({ _id: provinceId }))) {
    throw notFound('PROVINCE_NOT_FOUND', `No province with id ${provinceId}.`);
  }
  checkMember(auth, { province_id: provinceId, district_id: null }, 'province', 'province-id');
}

module.exports = { listProvinces, getProvince, ensureProvinceReadable };
