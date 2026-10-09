const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

const provinceSchema = new mongoose.Schema(
  {
    // Readable code stored as _id, so an unknown id is simply "not found", never a cast error.
    _id: { type: String, required: true, match: /^PV-\d{2}$/ },
    name: { type: String, required: true, trim: true },
  },
  {
    collection: 'provinces',
    // Indexes are built once by scripts/setup-db.js, not on every serverless cold start.
    autoIndex: false,
    // When the record was loaded or last changed: the source of its Last-Modified header.
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: toJsonOptions('province_id', ['created_at', 'updated_at']),
  }
);

module.exports = mongoose.model('Province', provinceSchema);
