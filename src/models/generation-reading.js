const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

const generationReadingSchema = new mongoose.Schema(
  {
    // Generated, not readable: devices create readings at volume and nobody types these ids.
    // Stored as a string so a malformed id in a URL is "not found", never a cast error.
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toHexString(),
      match: /^[0-9a-f]{24}$/,
    },
    installation_id: { type: String, required: true, match: /^INS-\d{4}$/, ref: 'SolarInstallation' },
    // When the device measured.
    timestamp: { type: Date, required: true },
    power_kw: { type: Number, required: true, min: 0 },
    // Cumulative meter total since the meter started; it never decreases.
    energy_kwh: { type: Number, required: true, min: 0 },
    voltage: { type: Number, required: true, min: 0 },
    // When the server stored it, so delayed or resent readings can be told apart from device time.
    received_at: { type: Date, required: true, default: Date.now },
    // Copied from the installation when the reading is stored, never taken from the device,
    // so jurisdiction checks and summaries can match readings directly.
    substation_id: { type: String, required: true, match: /^SS-\d{3}$/ },
    district_id: { type: String, required: true, match: /^DT-\d{2}$/ },
    province_id: { type: String, required: true, match: /^PV-\d{2}$/ },
  },
  {
    collection: 'generation_readings',
    autoIndex: false,
    // Readings never change, so there is no updated_at; received_at feeds Last-Modified.
    toJSON: toJsonOptions('reading_id', ['substation_id', 'district_id', 'province_id']),
  }
);

// One reading per installation per timestamp: a device retry cannot store a duplicate.
// The same index finds the latest reading and pages one installation's history.
generationReadingSchema.index({ installation_id: 1, timestamp: -1 }, { unique: true });
// District and province generation summaries.
generationReadingSchema.index({ district_id: 1, timestamp: -1 });
generationReadingSchema.index({ province_id: 1, timestamp: -1 });

module.exports = mongoose.model('GenerationReading', generationReadingSchema);
