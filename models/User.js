const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const transactionSchema = new mongoose.Schema({
    txid: { type: String, required: true },
    status: { type: String, default: 'pending_review' },
    date: { type: Date, default: Date.now },
    type: { type: String, enum: ['deposit', 'withdrawal'], default: 'deposit' },
    amount: { type: Number },
    address: { type: String },
    tax: { type: Number, default: 0 },
    finalAmount: { type: Number }
});

const userSchema = new mongoose.Schema({
  // --- NEW FIELDS FOR TELEGRAM LOGIN ---
  telegramId: {
    type: String,
    unique: true,
    sparse: true // Allows multiple users to exist without a telegramId
  },
  firstName: {
    type: String
  },
  lastName: {
    type: String
  },
  // ------------------------------------

  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  password: {
    type: String,
    // No longer required, to allow for passwordless Telegram users
  },
  balance: {
    type: Number,
    default: 0.00,
  },
  depositAddress: {
    type: String,
    unique: true,
    sparse: true,
  },
  depositAddressIndex: {
    type: Number,
    default: null,
    sparse: true,
  },
  transactions: [transactionSchema],

  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  referralCommissions: {
    type: Number,
    default: 0
  },
  withdrawalCount: {
    type: Number,
    default: 0
  },
  referralCount: {
    type: Number,
    default: 0
  },
  totalDeposits: {
    type: Number,
    required: true,
    default: 0
  },
  totalTradeVolume: {
    type: Number,
    required: true,
    default: 0
  },
  active_package: {
    type: String,
    default: null
  },
  package_expiry_date: {
    type: Date,
    default: null
  },
  last_claim_timestamp: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Your original password hashing middleware (unchanged)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  // Ensure password is not empty before hashing
  if (!this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Your original password comparison method (unchanged)
userSchema.methods.comparePassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
