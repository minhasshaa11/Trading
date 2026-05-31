const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const ChatThread = require("../models/Chat");

var MAX_ADMIN_MSG_LENGTH = 2000;
function sanitizeMessage(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .trim()
        .substring(0, MAX_ADMIN_MSG_LENGTH);
}

var adminAuth = function (req, res, next) {
    var adminKey = req.headers["x-admin-key"];
    var expectedKey = process.env.ADMIN_KEY;
    if (!adminKey || !expectedKey) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
    }
    try {
        var keyBuffer = Buffer.from(adminKey);
        var expectedBuffer = Buffer.from(expectedKey);
        if (keyBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(keyBuffer, expectedBuffer)) {
            return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
        }
    } catch (e) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
    }
    next();
};

function isValidObjectId(id) {
    return id && mongoose.Types.ObjectId.isValid(id);
}

router.use(adminAuth);

// GET api/admin/support/tickets
router.get("/support/tickets", async function (req, res) {
    try {
        var page = parseInt(req.query.page) || 1;
        var limit = parseInt(req.query.limit) || 20;
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;
        var skip = (page - 1) * limit;

        var statusFilter = req.query.status;
        var query = {};
        if (statusFilter && statusFilter !== "all") {
            query.status = statusFilter;
        } else {
            query.status = { $ne: "closed" };
        }

        var total = await ChatThread.countDocuments(query);
        var tickets = await ChatThread.find(query)
            .populate("userId", "username firstName")
            .sort({ lastUpdated: -1 })
            .skip(skip)
            .limit(limit);

        var formattedTickets = [];
        for (var i = 0; i < tickets.length; i++) {
            var ticket = tickets[i];
            var userData = ticket.userId;
            formattedTickets.push({
                _id: ticket._id,
                user: userData
                    ? { username: userData.username || null, firstName: userData.firstName || null, _id: userData._id }
                    : { username: "Deleted User", firstName: "", _id: null },
                status: ticket.status,
                lastUpdated: ticket.lastUpdated,
                messageCount: ticket.messages.length,
                lastMessage: ticket.messages.length > 0 ? ticket.messages[ticket.messages.length - 1] : null,
            });
        }

        res.json({ success: true, tickets: formattedTickets, pagination: { page: page, limit: limit, total: total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        console.error("Error fetching support tickets:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching tickets." });
    }
});

// GET api/admin/support/messages/:chatId
router.get("/support/messages/:chatId", async function (req, res) {
    try {
        var chatId = req.params.chatId;
        if (!isValidObjectId(chatId)) {
            return res.status(400).json({ success: false, message: "Invalid chat ID." });
        }
        var thread = await ChatThread.findById(chatId)
            .select("messages userId status")
            .populate("userId", "username firstName");
        if (!thread) {
            return res.status(404).json({ success: false, message: "Chat thread not found." });
        }
        res.json({ success: true, messages: thread.messages, user: thread.userId, status: thread.status });
    } catch (error) {
        console.error("Error fetching chat messages:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching messages." });
    }
});

// POST api/admin/support/send-reply
router.post("/support/send-reply", async function (req, res) {
    var chatId = req.body.chatId;
    var content = req.body.content;

    if (!content || content.trim() === "") {
        return res.status(400).json({ success: false, message: "Reply content cannot be empty." });
    }
    if (content.length > MAX_ADMIN_MSG_LENGTH) {
        return res.status(400).json({ success: false, message: "Message too long. Max " + MAX_ADMIN_MSG_LENGTH + " characters." });
    }
    if (!isValidObjectId(chatId)) {
        return res.status(400).json({ success: false, message: "Invalid chat ID." });
    }

    try {
        var thread = await ChatThread.findById(chatId);
        if (!thread) {
            return res.status(404).json({ success: false, message: "Chat thread not found." });
        }
        var newMessage = { sender: "admin", content: sanitizeMessage(content), timestamp: new Date() };
        thread.messages.push(newMessage);
        thread.status = "open";
        thread.lastUpdated = new Date();
        await thread.save();
        res.json({ success: true, message: "Reply sent.", newMessage: newMessage });
    } catch (err) {
        console.error("Error sending admin reply:", err.message);
        res.status(500).json({ success: false, message: "Server error during reply send." });
    }
});

// POST api/admin/support/close-ticket
router.post("/support/close-ticket", async function (req, res) {
    var chatId = req.body.chatId;
    if (!isValidObjectId(chatId)) {
        return res.status(400).json({ success: false, message: "Invalid chat ID." });
    }
    try {
        var result = await ChatThread.findByIdAndUpdate(
            chatId,
            { $set: { status: "closed", lastUpdated: new Date() } },
            { new: true }
        );
        if (!result) {
            return res.status(404).json({ success: false, message: "Chat thread not found." });
        }
        res.json({ success: true, message: "Ticket closed." });
    } catch (err) {
        console.error("Error closing ticket:", err.message);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// GET api/admin/data
router.get("/data", async function (req, res) {
    try {
        var page = parseInt(req.query.page) || 1;
        var limit = parseInt(req.query.limit) || 20;
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;
        var skip = (page - 1) * limit;

        var query = {};
        if (req.query.search) {
            var searchRegex = new RegExp(req.query.search, "i");
            query = { $or: [{ username: searchRegex }, { firstName: searchRegex }, { telegramId: req.query.search }] };
        }

        var total = await User.countDocuments(query);
        var users = await User.find(query)
            .select("-password")
            .populate("referredBy", "username firstName")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        res.json({ success: true, users: users, pagination: { page: page, limit: limit, total: total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        console.error("Admin data error:", error.message);
        res.status(500).json({ success: false, message: "Server error fetching data." });
    }
});

// POST api/admin/approve-deposit
router.post("/approve-deposit", async function (req, res) {
    var userId = req.body.userId;
    var txid = req.body.txid;

    if (!userId || !txid) return res.status(400).json({ success: false, message: "Missing required fields." });
    if (!isValidObjectId(userId)) return res.status(400).json({ success: false, message: "Invalid user ID." });

    try {
        var user = await User.findById(userId).select("transactions totalDeposits referredBy");
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        var transaction = user.transactions.find(function (tx) { return tx.txid === txid; });
        if (!transaction) return res.status(400).json({ success: false, message: "Transaction not found." });

        var depositAmount = parseFloat(transaction.amount);
        if (isNaN(depositAmount) || depositAmount <= 0) return res.status(400).json({ success: false, message: "Invalid transaction amount." });

        var isFirstDeposit = (user.totalDeposits || 0) === 0;

        var result = await User.findOneAndUpdate(
            { _id: userId, "transactions.txid": txid, "transactions.status": "pending_review" },
            { $set: { "transactions.$.status": "completed" }, $inc: { balance: depositAmount, totalDeposits: depositAmount } },
            { new: true }
        );

        if (!result) return res.status(400).json({ success: false, message: "Transaction not found or already processed." });

        if (isFirstDeposit && user.referredBy) {
            try {
                var commissionAmount = depositAmount * 0.07;
                await User.findByIdAndUpdate(user.referredBy, {
                    $inc: { balance: commissionAmount, referralCommissions: commissionAmount }
                });
            } catch (commissionError) {
                console.error("Failed to award referral commission:", commissionError.message);
            }
        }

        res.json({ success: true, message: "Deposit of $" + depositAmount.toFixed(2) + " approved. New balance: $" + result.balance.toFixed(2) });
    } catch (error) {
        console.error("Approve deposit error:", error.message);
        res.status(500).json({ success: false, message: "Server error during approval." });
    }
});

// POST api/admin/reject-deposit
router.post("/reject-deposit", async function (req, res) {
    var userId = req.body.userId;
    var txid = req.body.txid;

    if (!userId || !txid) return res.status(400).json({ success: false, message: "Missing required fields." });
    if (!isValidObjectId(userId)) return res.status(400).json({ success: false, message: "Invalid user ID." });

    try {
        var result = await User.findOneAndUpdate(
            { _id: userId, "transactions.txid": txid, "transactions.status": { $in: ["pending", "pending_review"] } },
            { $set: { "transactions.$.status": "rejected" } },
            { new: true }
        );
        if (!result) return res.status(400).json({ success: false, message: "Transaction not found or already processed." });
        res.json({ success: true, message: "Deposit rejected." });
    } catch (error) {
        console.error("Reject deposit error:", error.message);
        res.status(500).json({ success: false, message: "Server error during rejection." });
    }
});

// POST api/admin/approve-withdrawal
router.post("/approve-withdrawal", async function (req, res) {
    var userId = req.body.userId;
    var txid = req.body.txid;

    if (!userId || !txid) return res.status(400).json({ success: false, message: "Missing required fields." });
    if (!isValidObjectId(userId)) return res.status(400).json({ success: false, message: "Invalid user ID." });

    try {
        var result = await User.findOneAndUpdate(
            { _id: userId, "transactions.txid": txid, "transactions.status": "pending_processing" },
            { $set: { "transactions.$.status": "completed" } },
            { new: true }
        );
        if (!result) return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });
        res.json({ success: true, message: "Withdrawal approved and marked as complete." });
    } catch (error) {
        console.error("Approve withdrawal error:", error.message);
        res.status(500).json({ success: false, message: "Server error during withdrawal approval." });
    }
});

// POST api/admin/reject-withdrawal
router.post("/reject-withdrawal", async function (req, res) {
    var userId = req.body.userId;
    var txid = req.body.txid;

    if (!userId || !txid) return res.status(400).json({ success: false, message: "Missing required fields." });
    if (!isValidObjectId(userId)) return res.status(400).json({ success: false, message: "Invalid user ID." });

    try {
        var user = await User.findOne({
            _id: userId,
            "transactions.txid": txid,
            "transactions.status": "pending_processing"
        });
        if (!user) return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });

        var transaction = user.transactions.find(function (tx) {
            return tx.txid === txid && tx.status === "pending_processing";
        });
        if (!transaction) return res.status(400).json({ success: false, message: "Transaction not found." });

        var refundAmount = transaction.amount || 0;

        var result = await User.findOneAndUpdate(
            { _id: userId, "transactions.txid": txid, "transactions.status": "pending_processing" },
            { $set: { "transactions.$.status": "rejected" }, $inc: { balance: refundAmount } },
            { new: true }
        );
        if (!result) return res.status(400).json({ success: false, message: "Withdrawal already processed by another request." });
        res.json({ success: true, message: "Withdrawal rejected. $" + refundAmount.toFixed(2) + " has been refunded." });
    } catch (error) {
        console.error("Reject withdrawal error:", error.message);
        res.status(500).json({ success: false, message: "Server error during withdrawal rejection." });
    }
});

// POST api/admin/credit-user (Hidden - no history)
router.post("/credit-user", async function (req, res) {
    var username = req.body.username;
    var amount = req.body.amount;

    if (!username || !amount || isNaN(parseFloat(amount))) {
        return res.status(400).json({ success: false, message: "Username and a valid amount are required." });
    }

    var creditAmount = parseFloat(amount);
    if (creditAmount === 0) return res.status(400).json({ success: false, message: "Amount cannot be zero." });

    try {
        var user = await User.findOneAndUpdate(
            { username: username },
            {
                $inc: { balance: creditAmount },
                $push: {
                    transactions: {
                        txid: "ADMIN-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
                        type: "admin_credit",
                        amount: Math.abs(creditAmount),
                        status: "completed",
                        currency: "USD",
                        date: new Date(),
                    },
                },
            },
            { new: true }
        );

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        console.log("ADMIN ACTION: " + (creditAmount > 0 ? "Credited" : "Debited") + " $" + Math.abs(creditAmount).toFixed(2) + " " + (creditAmount > 0 ? "to" : "from") + " " + username);
        res.json({ success: true, message: "Successfully updated " + username + "'s balance to $" + user.balance.toFixed(2) });
    } catch (error) {
        console.error("Credit user error:", error.message);
        res.status(500).json({ success: false, message: "Server error while crediting user." });
    }
});

// POST api/admin/manual-deposit (Visible in deposit history)
router.post("/manual-deposit", async function (req, res) {
    var username = req.body.username;
    var amount = req.body.amount;

    if (!username || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Username and a valid positive amount are required." });
    }

    var depositAmount = parseFloat(amount);

    try {
        var user = await User.findOneAndUpdate(
            { username: username },
            {
                $inc: { balance: depositAmount, totalDeposits: depositAmount },
                $push: {
                    transactions: {
                        txid: "MANUAL-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
                        type: "deposit",
                        amount: depositAmount,
                        status: "completed",
                        currency: "USD",
                        date: new Date(),
                    },
                },
            },
            { new: true }
        );

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        console.log("ADMIN ACTION: Manual deposit of $" + depositAmount.toFixed(2) + " to " + username);
        res.json({ success: true, message: "Successfully deposited $" + depositAmount.toFixed(2) + " to " + username + "'s account." });
    } catch (error) {
        console.error("Manual deposit error:", error.message);
        res.status(500).json({ success: false, message: "Server error while processing manual deposit." });
    }
});

// POST api/admin/give-commission
router.post("/give-commission", async function (req, res) {
    var username = req.body.username;
    var amount = req.body.amount;

    if (!username || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Username and a valid positive amount are required." });
    }

    try {
        var commissionAmount = parseFloat(amount);
        var user = await User.findOneAndUpdate(
            { username: username },
            { $inc: { balance: commissionAmount, referralCommissions: commissionAmount } },
            { new: true }
        );

        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        console.log("ADMIN ACTION: Awarded $" + commissionAmount.toFixed(2) + " commission to " + username);
        res.json({ success: true, message: "Successfully awarded $" + commissionAmount.toFixed(2) + " commission to " + username + "." });
    } catch (error) {
        console.error("Give commission error:", error.message);
        res.status(500).json({ success: false, message: "Server error while giving commission." });
    }
});

module.exports = router;
