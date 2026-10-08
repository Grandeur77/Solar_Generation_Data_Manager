// Small, hand-checkable test data. Fixed dates and round numbers, so every expected value
// below can be worked out on paper. Sri Lanka time (Asia/Colombo) is UTC+05:30.
//
// Hierarchy
//   PV-01 Western  -> DT-01 Colombo (SS-001), DT-02 Gampaha (SS-002)
//   PV-02 Central  -> DT-04 Kandy (SS-003)
//
// Installations
//   INS-0001  SS-001 Colombo  5 kW  active    5 readings
//   INS-0002  SS-001 Colombo  3 kW  active    3 readings
//   INS-0003  SS-002 Gampaha  4 kW  active    2 readings (none before 6 Oct)
//   INS-0004  SS-003 Kandy   10 kW  inactive  1 old reading (stopped reporting)
//   INS-0005  SS-001 Colombo  2 kW  active    no readings
//
// Hand-computed values for Sri Lanka day 2026-10-06
//   Latest INS-0001: 2026-10-06T12:30:00Z (18:00 SL), power 0.5, energy 1020
//   Latest INS-0002: 2026-10-06T12:30:00Z (18:00 SL), power 1.0, energy 510
//   DT-01 current total power = 0.5 + 1.0 = 1.5 kW (INS-0005 has no readings)
//   DT-01 day energy = (1020 - 1000) + (510 - 500) = 30 kWh
//     The baseline is the last reading BEFORE the day starts at 2026-10-05T18:30:00Z,
//     i.e. the 23:45 SL readings. This data cannot catch a timezone bug: a UTC day would differ
//     only between 18:30 and 24:00 UTC (00:00-05:30 SL), when generation is always zero, so both
//     give 30 kWh. The day boundary itself must be tested directly on the day-window function.
//   DT-02 day energy = 802.75 - 800 = 2.75 kWh (no earlier reading, so the day's first is the baseline)

const provinces = [
  { province_id: 'PV-01', name: 'Western' },
  { province_id: 'PV-02', name: 'Central' },
];

const districts = [
  { district_id: 'DT-01', name: 'Colombo', province_id: 'PV-01' },
  { district_id: 'DT-02', name: 'Gampaha', province_id: 'PV-01' },
  { district_id: 'DT-04', name: 'Kandy', province_id: 'PV-02' },
];

const substations = [
  { substation_id: 'SS-001', name: 'Kolonnawa Grid Substation', district_id: 'DT-01' },
  { substation_id: 'SS-002', name: 'Gampaha Grid Substation', district_id: 'DT-02' },
  { substation_id: 'SS-003', name: 'Kandy Grid Substation', district_id: 'DT-04' },
];

const site = (id, n, substation_id, district_id, province_id, capacity_kw, status, town) => ({
  installation_id: id,
  name: `${town} test rooftop ${n}`,
  meter_id: `MTR-00000${n}`,
  substation_id,
  district_id,
  province_id,
  capacity_kw,
  status,
  commissioned_at: '2024-01-15T00:00:00Z',
  address: `No. ${n}, Test Road, ${town}`,
  latitude: 6.9,
  longitude: 79.9,
});

const installations = [
  site('INS-0001', 1, 'SS-001', 'DT-01', 'PV-01', 5, 'active', 'Kolonnawa'),
  site('INS-0002', 2, 'SS-001', 'DT-01', 'PV-01', 3, 'active', 'Kolonnawa'),
  site('INS-0003', 3, 'SS-002', 'DT-02', 'PV-01', 4, 'active', 'Gampaha'),
  site('INS-0004', 4, 'SS-003', 'DT-04', 'PV-02', 10, 'inactive', 'Kandy'),
  site('INS-0005', 5, 'SS-001', 'DT-01', 'PV-01', 2, 'active', 'Kolonnawa'),
];

// [reading_id, installation_id, timestamp (UTC), power_kw, energy_kwh, voltage]
// received_at is the timestamp + 5 s; the jurisdiction copies come from the installation.
const readingRows = [
  ['000000000000000000000001', 'INS-0001', '2026-10-05T18:15:00Z', 0, 1000, 229.5], // 23:45 SL, 5 Oct
  ['000000000000000000000002', 'INS-0001', '2026-10-06T00:30:00Z', 0, 1000, 229.8], // 06:00 SL
  ['000000000000000000000003', 'INS-0001', '2026-10-06T04:30:00Z', 3, 1006, 232.1], // 10:00 SL
  ['000000000000000000000004', 'INS-0001', '2026-10-06T06:30:00Z', 4, 1013, 233.4], // 12:00 SL
  ['000000000000000000000005', 'INS-0001', '2026-10-06T12:30:00Z', 0.5, 1020, 230.2], // 18:00 SL (latest)
  ['000000000000000000000006', 'INS-0002', '2026-10-05T18:15:00Z', 0, 500, 229.6], // 23:45 SL, 5 Oct
  ['000000000000000000000007', 'INS-0002', '2026-10-06T06:30:00Z', 2, 506, 232.9], // 12:00 SL
  ['000000000000000000000008', 'INS-0002', '2026-10-06T12:30:00Z', 1, 510, 230.4], // 18:00 SL (latest)
  ['000000000000000000000009', 'INS-0003', '2026-10-06T05:00:00Z', 2.5, 800, 231.7], // 10:30 SL
  ['00000000000000000000000a', 'INS-0003', '2026-10-06T06:00:00Z', 3, 802.75, 232.6], // 11:30 SL (latest)
  ['00000000000000000000000b', 'INS-0004', '2026-10-02T06:30:00Z', 6, 2000, 231.0], // stopped after this
];

const installationById = new Map(installations.map((i) => [i.installation_id, i]));
const readings = readingRows.map(([reading_id, installation_id, timestamp, power_kw, energy_kwh, voltage]) => {
  const i = installationById.get(installation_id);
  return {
    reading_id,
    installation_id,
    timestamp,
    power_kw,
    energy_kwh,
    voltage,
    received_at: new Date(Date.parse(timestamp) + 5000).toISOString(),
    substation_id: i.substation_id,
    district_id: i.district_id,
    province_id: i.province_id,
  };
});

// Test-only credentials. They exist only in the throwaway in-memory test database.
const users = [
  { user_id: 'USR-001', name: 'Test National', email: 'national@test.example', role: 'analyst', jurisdiction_level: 'national', status: 'active', password: 'test-national-pass' },
  { user_id: 'USR-002', name: 'Test Western', email: 'western@test.example', role: 'analyst', jurisdiction_level: 'province', province_id: 'PV-01', status: 'active', password: 'test-western-pass' },
  { user_id: 'USR-003', name: 'Test Central', email: 'central@test.example', role: 'analyst', jurisdiction_level: 'province', province_id: 'PV-02', status: 'active', password: 'test-central-pass' },
  { user_id: 'USR-004', name: 'Test Colombo', email: 'colombo@test.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-01', status: 'active', password: 'test-colombo-pass' },
  { user_id: 'USR-005', name: 'Test Gampaha', email: 'gampaha@test.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-02', status: 'active', password: 'test-gampaha-pass' },
  { user_id: 'USR-006', name: 'Test Kandy (inactive)', email: 'kandy@test.example', role: 'analyst', jurisdiction_level: 'district', district_id: 'DT-04', status: 'inactive', password: 'test-kandy-pass' },
  { user_id: 'USR-007', name: 'Test Registry Admin', email: 'admin@test.example', role: 'registry_admin', jurisdiction_level: 'national', status: 'active', password: 'test-admin-pass' },
];

// Test-only device secrets, one per installation.
const deviceSecrets = Object.fromEntries(installations.map((i) => [i.installation_id, `test-device-secret-${i.installation_id}`]));

module.exports = { provinces, districts, substations, installations, readings, users, deviceSecrets };
