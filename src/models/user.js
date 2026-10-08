const mongoose = require('mongoose');
const { toJsonOptions } = require('./to-json');

const userSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, match: /^USR-\d{3}$/ },
    name: { type: String, required: true, trim: true },
    // Stored lowercase so "A@slsea.lk" and "a@slsea.lk" are the same account.
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      unique: true,
    },
    role: { type: String, required: true, enum: ['analyst', 'registry_admin'] },
    jurisdiction_level: { type: String, required: true, enum: ['national', 'province', 'district'] },
    province_id: { type: String, match: /^PV-\d{2}$/, ref: 'Province' },
    district_id: { type: String, match: /^DT-\d{2}$/, ref: 'District' },
    status: { type: String, required: true, enum: ['active', 'inactive'] },
    // bcrypt hash only, never the password. Hidden from queries and from JSON.
    password_hash: { type: String, required: true, select: false },
  },
  {
    collection: 'users',
    autoIndex: false,
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: toJsonOptions('user_id', ['password_hash', 'created_at', 'updated_at']),
  }
);

// One jurisdiction per user: national has no id, province has only province_id,
// district has only district_id. A registry admin maintains the whole registry, so is national.
userSchema.pre('validate', function checkJurisdiction() {
  const level = this.jurisdiction_level;
  const hasProvince = Boolean(this.province_id);
  const hasDistrict = Boolean(this.district_id);

  if (level === 'national' && (hasProvince || hasDistrict)) {
    this.invalidate('jurisdiction_level', 'A national user has no province_id or district_id');
  }
  if (level === 'province' && (!hasProvince || hasDistrict)) {
    this.invalidate('province_id', 'A province user needs province_id and no district_id');
  }
  if (level === 'district' && (!hasDistrict || hasProvince)) {
    this.invalidate('district_id', 'A district user needs district_id and no province_id');
  }
  if (this.role === 'registry_admin' && level !== 'national') {
    this.invalidate('jurisdiction_level', 'A registry admin must be national');
  }
});

module.exports = mongoose.model('User', userSchema);
