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
    toJSON: toJsonOptions('province_id'),
  }
);

module.exports = mongoose.model('Province', provinceSchema);
