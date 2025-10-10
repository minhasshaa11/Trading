const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Admin security middleware (unchanged)
const adminAuth = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
    }
    next();
};

router.use(adminAuth);

// GET all admin data (unchanged)
router.get('/data', async (req, res) => {
    try {
        const searchQuery = req.query.search ? { username: new RegExp(req.query.search, 'i') } : {};
        const users = await User.find(searchQuery).populate('referredBy', 'username').sort({ createdAt: -1 });
        
        res.json({
            success: true,
            users: users,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching data." });
    }
});

// --- DEPOSIT & WITHDRAWAL MANAGEMENT ---
router.post('/approve-deposit', async (req, res) => {
    const { userId, txid } = req.body;
    if (!userId || !txid) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_review') {
            return res.status(400).json({ success: false, message: "Transaction not found or already processed." });
        }
        
        const depositAmount = parseFloat(transaction.amount);
        if (isNaN(depositAmount)) {
            return res.status(400).json({ success: false, message: "Invalid transaction amount stored." });
        }

        // --- Check if this is the user's first deposit ---
        const isFirstDeposit = (user.totalDeposits || 0) === 0;
        // ---------------------------------------------------

        transaction.status = 'completed';
        user.balance += depositAmount;
        user.totalDeposits += depositAmount;
        
        await user.save();

        // --- NEW: AUTOMATIC 2% REFERRAL COMMISSION LOGIC ---
        if (isFirstDeposit && user.referredBy) {
            try {
                const commissionRate = 0.02; // 2% commission
                const commissionAmount = depositAmount * commissionRate;

                // Find the referrer and award them the commission
                await User.findByIdAndUpdate(user.referredBy, {
                    $inc: { 
                        balance: commissionAmount,
                        referralCommissions: commissionAmount 
                    }
                });
                console.log(`AWARDED: $${commissionAmount.toFixed(2)} (2%) commission to referrer ID: ${user.referredBy} for a $${depositAmount.toFixed(2)} deposit.`);
            } catch (commissionError) {
                console.error("Failed to award referral commission:", commissionError);
                // We don't stop the main process, just log the error that it failed
            }
        }
        // -------------------------------------------------
        
        res.json({ success: true, message: `Deposit of $${depositAmount.toFixed(2)} approved. New balance: ${user.balance.toFixed(2)}` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during approval." });
    }
});

router.post('/reject-deposit', async (req, res) => {
    // This route is unchanged
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (transaction) {
            transaction.status = 'rejected';
            await user.save();
        }
        res.json({ success: true, message: "Deposit rejected." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during rejection." });
    }
});

// ... (The rest of your routes are unchanged)

router.post('/approve-withdrawal', async (req, res) => {
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_processing') {
            return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });
        }
        transaction.status = 'completed';
        await user.save();
        res.json({ success: true, message: "Withdrawal approved and marked as complete." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during withdrawal approval." });
    }
});

router.post('/reject-withdrawal', async (req, res) => {
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_processing') {
            return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });
        }
        transaction.status = 'rejected';
        user.balance += transaction.amount;
        await user.save();
        res.json({ success: true, message: `Withdrawal rejected. $${transaction.amount.toFixed(2)} has been refunded to the user.` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during withdrawal rejection." });
    }
});

router.post('/credit-user', async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount || isNaN(parseFloat(amount))) {
        return res.status(400).json({ success: false, message: "Username and a valid amount are required." });
    }
    try {
        const user = await User.findOne({ username: username });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        user.balance += parseFloat(amount);
        await user.save();
        res.json({ success: true, message: `Successfully updated ${user.username}'s balance to ${user.balance.toFixed(2)}` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error while crediting user." });
    }
});

router.post('/give-commission', async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Username and a valid positive amount are required." });
    }
    try {
        const commissionAmount = parseFloat(amount);
        const user = await User.findOneAndUpdate(
            { username: username }, 
            { $inc: { balance: commissionAmount, referralCommissions: commissionAmount } },
            { new: true }
        );
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        
        console.log(`ADMIN ACTION: Awarded $${commissionAmount.toFixed(2)} commission to ${user.username}.`);
        res.json({ success: true, message: `Successfully awarded $${commissionAmount.toFixed(2)} commission to ${user.username}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error while giving commission." });
    }
});

module.exports = router;
