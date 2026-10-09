const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

const districtSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, match: /^DT-\d{2}$/ },
    name: { type: String, required: true, trim: true },
    // Parent reference. MongoDB has no foreign keys, so the seed check and services verify it exists.
    province_id: { type: String, required: true, match: /^PV-\d{2}$/, ref: 'Province', index: true },
  },
  {
    collection: 'districts',
    autoIndex: false,
    // When the record was loaded or last changed: the source of its Last-Modified header.
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: toJsonOptions('district_id', ['created_at', 'updated_at']),
  }
);

module.exports = mongoose.model('District', districtSchema);
