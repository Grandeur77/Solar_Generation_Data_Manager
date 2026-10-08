const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

// Field order here is the order clients see in JSON.
const solarInstallationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, match: /^INS-\d{4}$/ },
    name: { type: String, required: true, trim: true },
    // The meter is an attribute of the site, not a separate entity; unique so one meter maps to one site.
    meter_id: { type: String, required: true, match: /^MTR-\d{6}$/, unique: true },
    substation_id: { type: String, required: true, match: /^SS-\d{3}$/, ref: 'GridSubstation', index: true },
    // Copies of the substation's district and province, set by the server (never by the client)
    // so installations can be filtered and scope-checked without loading the substation.
    district_id: { type: String, required: true, match: /^DT-\d{2}$/, index: true },
    province_id: { type: String, required: true, match: /^PV-\d{2}$/, index: true },
    capacity_kw: {
      type: Number,
      required: true,
      validate: { validator: (v) => v > 0, message: 'capacity_kw must be greater than 0' },
    },
    status: { type: String, required: true, enum: ['active', 'inactive'] },
    commissioned_at: { type: Date, required: true },
    address: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    // bcrypt hash of the device's secret. select: false keeps it out of normal queries;
    // the toJSON transform removes it again in case a query asks for it explicitly.
    device_secret_hash: { type: String, select: false },
  },
  {
    collection: 'installations',
    autoIndex: false,
    // Change times feed the Last-Modified header; they are not part of the JSON body.
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: toJsonOptions('installation_id', ['device_secret_hash', 'created_at', 'updated_at']),
  }
);

module.exports = mongoose.model('SolarInstallation', solarInstallationSchema);
