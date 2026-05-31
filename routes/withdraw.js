const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

router.use(authMiddleware);

// --- WITHDRAWAL RULES ---
var MINIMUM_WITHDRAWAL = 10;
var MAXIMUM_WITHDRAWAL = 5000;
var WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL = 2;
var MAX_PENDING_WITHDRAWALS = 3;

/* FIX 3: TRC20 address validation */
function isValidTRC20Address(address) {
    if (!address || typeof address !== "string") return false;
    var trimmed = address.trim();
    /* TRC20 addresses: start with T, 34 chars, base58 characters */
    var trc20Regex = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
    return trc20Regex.test(trimmed);
}

/* FIX 4: Generate unique txid */
function generateWithdrawTxid() {
    return "WITHDRAW-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
}

router.post("/request", async function (req, res) {
    var amount = req.body.amount;
    var address = req.body.address;
    var withdrawalAmount = parseFloat(amount);

    // --- Input Validation ---
    if (!amount || isNaN(withdrawalAmount) || withdrawalAmount < MINIMUM_WITHDRAWAL) {
        return res.status(400).json({
            success: false,
            message: "Minimum withdrawal amount is $" + MINIMUM_WITHDRAWAL + ".",
        });
    }

    /* FIX 2: Maximum withdrawal limit */
    if (withdrawalAmount > MAXIMUM_WITHDRAWAL) {
        return res.status(400).json({
            success: false,
            message: "Maximum withdrawal amount is $" + MAXIMUM_WITHDRAWAL + " per request.",
        });
    }

    /* Prevent decimal abuse (max 2 decimal places) */
    if (Math.round(withdrawalAmount * 100) !== withdrawalAmount * 100) {
        return res.status(400).json({
            success: false,
            message: "Amount can have maximum 2 decimal places.",
        });
    }

    /* FIX 3: Proper TRC20 address validation */
    if (!isValidTRC20Address(address)) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid TRC20 wallet address (starts with T, 34 characters).",
        });
    }

    try {
        /* FIX 6: Count referrals from DB instead of relying on a field */
        var user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        // --- Referral check ---
        var actualReferralCount = await User.countDocuments({
            referredBy: user._id,
        });

        if (
            (user.withdrawalCount || 0) >= WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL &&
            actualReferralCount === 0
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "You must refer at least one person to make more than " +
                    WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL +
                    " withdrawals.",
            });
        }

        /* FIX 7: Check pending withdrawals limit */
        var pendingCount = 0;
        if (user.transactions) {
            for (var i = 0; i < user.transactions.length; i++) {
                var tx = user.transactions[i];
                if (
                    tx.type === "withdrawal" &&
                    (tx.status === "pending_processing" || tx.status === "pending")
                ) {
                    pendingCount++;
                }
            }
        }

        if (pendingCount >= MAX_PENDING_WITHDRAWALS) {
            return res.status(400).json({
                success: false,
                message:
                    "You have " +
                    pendingCount +
                    " pending withdrawals. Please wait for them to be processed.",
            });
        }

        // --- Balance check (pre-check before atomic) ---
        if (user.balance < withdrawalAmount) {
            return res.status(400).json({
                success: false,
                message: "Insufficient balance.",
            });
        }

        /* FIX 4: Unique txid */
        var txid = generateWithdrawTxid();

        /* FIX 1: Atomic balance deduction to prevent race condition.
           Only deducts if balance is still sufficient at the moment of write. */
        var result = await User.findOneAndUpdate(
            {
                _id: req.user.id,
                balance: { $gte: withdrawalAmount },
            },
            {
                $inc: {
                    balance: -withdrawalAmount,
                    withdrawalCount: 1,
                },
                $push: {
                    transactions: {
                        txid: txid,
                        type: "withdrawal",
                        amount: withdrawalAmount,
                        address: address.trim(),
                        status: "pending_processing",
                        date: new Date(),
                    },
                },
            },
            { new: true }
        );

        if (!result) {
            return res.status(400).json({
                success: false,
                message:
                    "Withdrawal failed. Insufficient balance or concurrent request detected.",
            });
        }

        res.json({
            success: true,
            message:
                "Withdrawal request submitted successfully. It will be processed shortly.",
            newBalance: result.balance,
        });
    } catch (error) {
        console.error("Withdrawal request error:", error.message);
        res.status(500).json({
            success: false,
            message: "An internal server error occurred.",
        });
    }
});

router.get("/history", async function (req, res) {
    try {
        var user = await User.findById(req.user.id).select("transactions");
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found.",
            });
        }

        /* FIX 8: Pagination support */
        var page = parseInt(req.query.page) || 1;
        var limit = parseInt(req.query.limit) || 20;
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;

        var withdrawals = [];
        if (user.transactions) {
            for (var i = 0; i < user.transactions.length; i++) {
                if (user.transactions[i].type === "withdrawal") {
                    withdrawals.push(user.transactions[i]);
                }
            }
        }

        /* Sort newest first */
        withdrawals.sort(function (a, b) {
            return new Date(b.date) - new Date(a.date);
        });

        var total = withdrawals.length;
        var start = (page - 1) * limit;
        var paged = withdrawals.slice(start, start + limit);

        res.json({
            success: true,
            history: paged,
            pagination: {
                page: page,
                limit: limit,
                total: total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("Error fetching withdrawal history:", error.message);
        res.status(500).json({
            success: false,
            message: "Internal server error.",
        });
    }
});

module.exports = router;
