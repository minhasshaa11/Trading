const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs');

const transactionSchema = new mongoose.Schema({
    // In the new system, we initially store the NowPayments 'payment_id' here.
    // Once confirmed, you could optionally update it to the real blockchain Hash.
    txid: { type: String, required: true },
    
    // Added 'currency' so you know if they paid in 'usdttrc20', 'btc', etc.
    currency: { type: String }, 

    // NowPayments statuses: 'waiting', 'confirming', 'confirmed', 'sending', 'finished', 'failed'
    status: { type: String, default: 'pending' },
    
    date: { type: Date, default: Date.now },
    type: { type: String, enum: ['deposit', 'withdrawal'], default: 'deposit' },
    amount: { type: Number },
    
    // This will store the UNIQUE deposit address generated for this specific transaction
    address: { type: String }, 
    
    tax: { type: Number, default: 0 },
    finalAmount: { type: Number }
});

const userSchema = new mongoose.Schema({
    // --- FIELDS FOR TELEGRAM LOGIN ---
    telegramId: {
        type: String,
        unique: true,
        sparse: true 
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
        unique: true,
        trim: true,
        sparse: true
    },
    password: {
        type: String,
    },
    balance: {
        type: Number,
        default: 0.00,
    },
    
    // These fields are less important now that we generate unique addresses per transaction,
    // but we keep them to avoid breaking any old logic.
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

// Password hashing middleware
userSchema.pre('save', async function (next) {
    if (!this.isModified('password') || !this.password) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Password comparison method
userSchema.methods.comparePassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
