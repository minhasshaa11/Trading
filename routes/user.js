const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const User = require("../models/User");
const ChatThread = require("../models/Chat");
const authMiddleware = require("../middleware/auth");

// --- PACKAGE DEFINITIONS ---
const PACKAGES = {
    Bronze: { price: 30, dailyProfit: 1, durationDays: 90, tier: 1 },
    Silver: { price: 100, dailyProfit: 4, durationDays: 90, tier: 2 },
    Gold: { price: 200, dailyProfit: 9, durationDays: 90, tier: 3 },
    Platinum: { price: 500, dailyProfit: 23, durationDays: 90, tier: 4 },
    Diamond: { price: 1000, dailyProfit: 50, durationDays: 90, tier: 5 },
};

/* FIX 4: Chat message sanitization */
var MAX_CHAT_LENGTH = 2000;
function sanitizeMessage(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .trim()
        .substring(0, MAX_CHAT_LENGTH);
}

function handleUserNotFound(res) {
    return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
        authError: true,
    });
}

// GET api/user/info
router.get("/info", authMiddleware, async function (req, res) {
    try {
        var user = await User.findById(req.user.id).select("-password");
        if (!user) return handleUserNotFound(res);
        res.json({ success: true, user: user });
    } catch (error) {
        console.error("Error fetching user info:", error.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// GET api/user/referral-info
router.get("/referral-info", authMiddleware, async function (req, res) {
    try {
        var userId = new mongoose.Types.ObjectId(req.user.id);
        var user = await User.findById(userId).select(
            "referralCode referralCommissions"
        );
        if (!user) return handleUserNotFound(res);

        var referralCount = await User.countDocuments({ referredBy: userId });

        res.json({
            success: true,
            referralCode: user.referralCode,
            referralCount: referralCount,
            totalCommissions: user.referralCommissions || 0,
        });
    } catch (error) {
        console.error("Error fetching referral info:", error.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// POST api/user/purchase-package
router.post("/purchase-package", authMiddleware, async function (req, res) {
    var packageName = req.body.packageName;
    var selectedPackage = PACKAGES[packageName];

    if (!selectedPackage) {
        return res
            .status(404)
            .json({ success: false, message: "Package not found." });
    }

    try {
        /* FIX 1: Atomic operation to prevent race condition */
        /* FIX 3: Check that user isn't downgrading */
        var currentTier = 0;

        /* First, read current state to validate */
        var user = await User.findById(req.user.id).select(
            "balance active_package"
        );
        if (!user) return handleUserNotFound(res);

        if (user.balance < selectedPackage.price) {
            return res.status(400).json({
                success: false,
                message: "Insufficient balance to purchase this package.",
            });
        }

        /* FIX 3: Prevent downgrade */
        if (user.active_package && PACKAGES[user.active_package]) {
            currentTier = PACKAGES[user.active_package].tier;
            if (selectedPackage.tier <= currentTier) {
                return res.status(400).json({
                    success: false,
                    message:
                        "You already have an equal or higher package (" +
                        user.active_package +
                        "). Upgrade to a higher plan.",
                });
            }
        }

        var expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + selectedPackage.durationDays);

        /* FIX 1: Atomic update with balance condition to prevent race condition.
           This only updates if balance is still sufficient at the moment of write. */
        var result = await User.findOneAndUpdate(
            {
                _id: req.user.id,
                balance: { $gte: selectedPackage.price },
            },
            {
                $inc: { balance: -selectedPackage.price },
                $set: {
                    active_package: packageName,
                    package_expiry_date: expiryDate,
                },
            },
            { new: true }
        );

        if (!result) {
            return res.status(400).json({
                success: false,
                message:
                    "Purchase failed. Insufficient balance or concurrent request.",
            });
        }

        res.json({
            success: true,
            message: packageName + " package purchased successfully!",
            newBalance: result.balance,
        });
    } catch (error) {
        console.error("Purchase package error:", error.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// POST api/user/claim-earnings
router.post("/claim-earnings", authMiddleware, async function (req, res) {
    try {
        /* FIX 2: Atomic claim to prevent double-claim race condition */
        var now = new Date();
        var todayReset = new Date();
        todayReset.setUTCHours(0, 0, 0, 0);

        /* First read to validate package status */
        var user = await User.findById(req.user.id).select(
            "active_package package_expiry_date last_claim_timestamp"
        );
        if (!user) return handleUserNotFound(res);

        if (!user.active_package) {
            return res.status(400).json({
                success: false,
                message: "You do not have an active package.",
            });
        }

        if (now > user.package_expiry_date) {
            return res.status(400).json({
                success: false,
                message: "Your package has expired.",
            });
        }

        /* FIX 8: Safe PACKAGES lookup */
        var packageInfo = PACKAGES[user.active_package];
        if (!packageInfo) {
            return res.status(400).json({
                success: false,
                message:
                    "Invalid package detected. Please contact support.",
            });
        }
        var dailyProfit = packageInfo.dailyProfit;

        if (
            user.last_claim_timestamp &&
            user.last_claim_timestamp > todayReset
        ) {
            return res.status(400).json({
                success: false,
                message: "You have already claimed your profit for today.",
            });
        }

        /* FIX 2: Atomic update - only claim if last_claim_timestamp is still before today.
           This prevents double-claim even with concurrent requests. */
        var result = await User.findOneAndUpdate(
            {
                _id: req.user.id,
                active_package: { $ne: null },
                $or: [
                    { last_claim_timestamp: { $exists: false } },
                    { last_claim_timestamp: null },
                    { last_claim_timestamp: { $lte: todayReset } },
                ],
            },
            {
                $inc: {
    balance: dailyProfit,
    profit: dailyProfit
},
                $set: { last_claim_timestamp: now },
            },
            { new: true }
        );

        if (!result) {
            return res.status(400).json({
                success: false,
                message:
                    "Claim failed. You may have already claimed today.",
            });
        }

        res.json({
            success: true,
            message: "Successfully claimed $" + dailyProfit + " USDT!",
            newBalance: result.balance,
        });
    } catch (error) {
        console.error("Claim earnings error:", error.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// --- CUSTOMER SUPPORT CHAT ROUTES ---

// GET api/user/support/initialize-chat
router.get(
    "/support/initialize-chat",
    authMiddleware,
    async function (req, res) {
        try {
            var userId = req.user.id;
            var userExists = await User.findById(userId).select("_id");
            if (!userExists) return handleUserNotFound(res);

            var thread = await ChatThread.findOne({ userId: userId });

            if (!thread) {
                thread = new ChatThread({ userId: userId, status: "open" });
                await thread.save();
                return res.json({
                    success: true,
                    chatId: thread._id,
                    messages: [],
                    message: "New chat thread created.",
                });
            }

            res.json({
                success: true,
                chatId: thread._id,
                messages: thread.messages,
                message: "Existing chat thread loaded.",
            });
        } catch (err) {
            console.error("Error initializing user chat:", err.message);
            res.status(500).json({
                success: false,
                message: "Server error during chat initialization.",
            });
        }
    }
);

// POST api/user/support/send-message
router.post(
    "/support/send-message",
    authMiddleware,
    async function (req, res) {
        var chatId = req.body.chatId;
        var content = req.body.content;

        if (!content || content.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Message content cannot be empty.",
            });
        }

        /* FIX 5: Message length limit */
        if (content.length > MAX_CHAT_LENGTH) {
            return res.status(400).json({
                success: false,
                message:
                    "Message too long. Maximum " +
                    MAX_CHAT_LENGTH +
                    " characters allowed.",
            });
        }

        /* FIX: Validate chatId format */
        if (!chatId || !mongoose.Types.ObjectId.isValid(chatId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid chat ID.",
            });
        }

        try {
            var userId = req.user.id;
            var userExists = await User.findById(userId).select("_id");
            if (!userExists) return handleUserNotFound(res);

            var thread = await ChatThread.findOne({
                _id: chatId,
                userId: userId,
            });
            if (!thread) {
                return res.status(404).json({
                    success: false,
                    message: "Chat thread not found or access denied.",
                });
            }

            /* FIX 4: Sanitize message content */
            var newMessage = {
                sender: "user",
                content: sanitizeMessage(content),
                timestamp: new Date(),
            };

            thread.messages.push(newMessage);
            thread.status = "pending_admin_reply";
            thread.lastUpdated = new Date();

            await thread.save();

            res.json({
                success: true,
                message: "Message sent.",
                newMessage: newMessage,
            });
        } catch (err) {
            console.error("Error sending user message:", err.message);
            res.status(500).json({
                success: false,
                message: "Server error during message send.",
            });
        }
    }
);

// GET api/user/account-summary
router.get("/account-summary", authMiddleware, async function (req, res) {
    try {
        /* FIX 6: Only select needed fields, not entire transactions array */
        var user = await User.findById(req.user.id).select(
    "balance totalDeposits transactions profit"
);
        );
        if (!user) return handleUserNotFound(res);

        var totalWithdrawals = 0;
        if (user.transactions && user.transactions.length > 0) {
            for (var i = 0; i < user.transactions.length; i++) {
                var tx = user.transactions[i];
                if (tx.type === "withdrawal" && tx.status === "completed") {
                    totalWithdrawals += tx.amount || 0;
                }
            }
        }

        var lifetimeProfit = user.profit || 0;

        res.json({
            success: true,
            summary: {
                totalDeposits: user.totalDeposits || 0,
                totalWithdrawals: totalWithdrawals,
                lifetimeProfit: lifetimeProfit,
            },
        });
    } catch (err) {
        console.error("Error fetching account summary:", err.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// GET api/user/recent-activity
router.get("/recent-activity", authMiddleware, async function (req, res) {
    try {
        var user = await User.findById(req.user.id).select("transactions");
        if (!user) return handleUserNotFound(res);

        var activities = [];
        if (user.transactions && user.transactions.length > 0) {
            /* FIX 6: Sort and slice without mutating original array */
            activities = user.transactions
                .slice()
                .sort(function (a, b) {
                    return new Date(b.date) - new Date(a.date);
                })
                .slice(0, 10)
                .map(function (tx) {
                    return {
                        date: tx.date,
                        type: tx.type,
                        amount: tx.amount || 0,
                        status: tx.status,
                    };
                });
        }

        res.json({ success: true, activities: activities });
    } catch (err) {
        console.error("Error fetching recent activity:", err.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// GET api/user/my-referrals
router.get("/my-referrals", authMiddleware, async function (req, res) {
    try {
        var userExists = await User.findById(req.user.id).select("_id");
        if (!userExists) return handleUserNotFound(res);

        /* FIX 7: Pagination support */
        var page = parseInt(req.query.page) || 1;
        var limit = parseInt(req.query.limit) || 20;
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;
        var skip = (page - 1) * limit;

        var referrals = await User.find({ referredBy: req.user.id })
            .select("username firstName createdAt")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        var totalCount = await User.countDocuments({
            referredBy: req.user.id,
        });

        res.json({
            success: true,
            referrals: referrals,
            pagination: {
                page: page,
                limit: limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit),
            },
        });
    } catch (error) {
        console.error("Error fetching referrals:", error.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

module.exports = router;
