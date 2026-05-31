const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

var transactionSchema = new mongoose.Schema({
    txid: {
        type: String,
        required: true,
        index: true,
    },
    currency: { type: String },
    status: {
        type: String,
        default: "pending",
        enum: ["pending", "pending_processing", "completed", "failed", "expired"],
        index: true,
    },
    date: { type: Date, default: Date.now },
    /* FIX: admin_credit type add kiya */
    type: {
        type: String,
        enum: ["deposit", "withdrawal", "admin_credit"],
        required: true,
    },
    amount: {
        type: Number,
        required: true,
        min: [0.01, "Amount must be greater than 0"],
    },
    address: { type: String },
});

var userSchema = new mongoose.Schema(
    {
        telegramId: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
        firstName: { type: String, default: "" },
        lastName: { type: String, default: "" },
        username: {
            type: String,
            trim: true,
            sparse: true,
            default: null,
        },
        password: { type: String },
        balance: {
            type: Number,
            default: 0.0,
            min: [0, "Balance cannot be negative"],
        },
        transactions: [transactionSchema],
        referralCode: {
            type: String,
            unique: true,
            sparse: true,
            index: true,
        },
        referredBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        referralCommissions: {
            type: Number,
            default: 0,
            min: 0,
        },
        withdrawalCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        referralCount: {
            type: Number,
            default: 0,
            min: 0,
        },
        totalDeposits: {
            type: Number,
            default: 0,
            min: 0,
        },
        active_package: {
            type: String,
            default: null,
            enum: [null, "Bronze", "Silver", "Gold", "Platinum", "Diamond"],
        },
        package_expiry_date: {
            type: Date,
            default: null,
        },
        last_claim_timestamp: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

userSchema.index({ "transactions.txid": 1, "transactions.status": 1 });

userSchema.pre("findOneAndUpdate", function (next) {
    var update = this.getUpdate();
    if (
        update &&
        update.$set &&
        update.$set["transactions.$.status"] === "completed" &&
        update.$inc &&
        update.$inc.balance
    ) {
        if (update.$inc.balance > 0) {
            update.$inc.totalDeposits = update.$inc.balance;
        }
    }
    next();
});

userSchema.pre("save", async function (next) {
    if (!this.isModified("password") || !this.password) return next();
    var salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

userSchema.methods.comparePassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
