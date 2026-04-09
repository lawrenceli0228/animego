const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username:             { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 50 },
  email:                { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:             { type: String, required: true },
  role:                 { type: String, enum: ['admin', null], default: null },
  refreshToken:         { type: String, default: null },
  resetPasswordToken:   { type: String, default: null },
  resetPasswordExpires: { type: Date,   default: null }
}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Compare password
userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
