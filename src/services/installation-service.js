const SolarInstallation = require('../models/solar-installation');
const { notFound } = require('../utils/errors');

// Filters combine (AND). Installations carry copies of their district and province ids,
// so every filter is a direct, indexed match with no lookup through the substation.
async function listInstallations({ provinceId, districtId, substationId } = {}) {
  const filter = {};
  if (provinceId) filter.province_id = provinceId;
  if (districtId) filter.district_id = districtId;
  if (substationId) filter.substation_id = substationId;
  return SolarInstallation.find(filter).sort({ _id: 1 });
}

async function getInstallation(installationId) {
  const installation = await SolarInstallation.findById(installationId);
  if (!installation) throw notFound('INSTALLATION_NOT_FOUND', `No installation with id ${installationId}.`);
  return installation;
}

module.exports = { listInstallations, getInstallation };
