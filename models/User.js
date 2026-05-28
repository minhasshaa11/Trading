const mongoose = require('mongoose');
const bcryptjs = require('bcryptjs'); // Fixed to use bcryptjs consistently matching your old structure

const transactionSchema = new mongoose.Schema({
    txid: { type: String, required: true },
    currency: { type: String }, 
    status: { type: String, default: 'pending' },
    date: { type: Date, default: Date.now },
    type: { type: String, enum: ['deposit', 'withdrawal'], default: 'deposit' },
    amount: { type: Number },
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
    
    // --- PACKAGE & REWARD SYSTEM UPGRADES ---
    active_package: {
        type: String,
        enum: ['Silver', 'Gold', 'VIP', null], // Tracks Tier level names dynamically
        default: null
    },
    active_investment_amount: {
        type: Number, // Stores the explicit amount invested (e.g. 30, 150, 600)
        default: 0
    },
    package_expiry_date: {
        type: Date,
        default: null
    },
    last_claim_timestamp: {
        type: Date,
        default: null
    },
    earnings_today: {
        type: Number, // Stores the specific random dollar payout generated today
        default: 0.00
    },
    percentage_today: {
        type: String, // Stores the random ROI percentage string generated today (e.g., "3.42%")
        default: "0.00"
    }
}, {
    timestamps: true
});

// Password hashing middleware
userSchema.pre('save', async function (next) {
    if (!this.isModified('password') || !this.password) return next();
    try {
        const salt = await bcryptjs.genSalt(10);
        this.password = await bcryptjs.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

// Password comparison method
userSchema.methods.comparePassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcryptjs.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
