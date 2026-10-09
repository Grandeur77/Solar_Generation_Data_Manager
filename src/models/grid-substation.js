const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

const gridSubstationSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, match: /^SS-\d{3}$/ },
    name: { type: String, required: true, trim: true },
    district_id: { type: String, required: true, match: /^DT-\d{2}$/, ref: 'District', index: true },
  },
  {
    // Set explicitly; Mongoose would otherwise name it "gridsubstations".
    collection: 'grid_substations',
    autoIndex: false,
    // When the record was loaded or last changed: the source of its Last-Modified header.
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: toJsonOptions('substation_id', ['created_at', 'updated_at']),
  }
);

module.exports = mongoose.model('GridSubstation', gridSubstationSchema);
