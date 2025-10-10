const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// --- PACKAGE DEFINITIONS (Unchanged) ---
const PACKAGES = {
    "Bronze": { price: 20, dailyProfit: 1, durationDays: 30 },
    "Silver": { price: 100, dailyProfit: 5.5, durationDays: 30 },
    "Gold": { price: 200, dailyProfit: 12, durationDays: 30 },
    "Platinum": { price: 500, dailyProfit: 32.5, durationDays: 30 },
    "Diamond": { price: 1000, dailyProfit: 70, durationDays: 30 },
};
// -----------------------------------

// GET api/user/info - Provides basic user info
router.get('/info', authMiddleware, async (req, res) => {
    try {
        // CHANGED: Added firstName to the selection for better display on the profile
        const user = await User.findById(req.user.id).select('-password');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        res.json({ success: true, user: user });
    } catch (error) {
        console.error("Error fetching user info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET api/user/referral-info - Provides the user's referral data
router.get('/referral-info', authMiddleware, async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const user = await User.findById(userId).select('referralCode referralCommissions');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        
        const referralCount = await User.countDocuments({ referredBy: userId });
        
        res.json({
            success: true,
            referralCode: user.referralCode,
            referralCount: referralCount,
            totalCommissions: user.referralCommissions
        });
    } catch (error)
    {
        console.error("Error fetching referral info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST api/user/purchase-package - Handles purchasing an investment package
router.post('/purchase-package', authMiddleware, async (req, res) => {
    const { packageName } = req.body;
    const selectedPackage = PACKAGES[packageName];

    if (!selectedPackage) {
        return res.status(404).json({ success: false, message: "Package not found." });
    }
    
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (user.balance < selectedPackage.price) {
            return res.status(400).json({ success: false, message: "Insufficient balance to purchase this package." });
        }

        user.balance -= selectedPackage.price;
        user.active_package = packageName;
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + selectedPackage.durationDays);
        user.package_expiry_date = expiryDate;
        
        await user.save();
        res.json({ success: true, message: `${packageName} package purchased successfully!`, newBalance: user.balance });

    } catch (error) {
        console.error("Purchase package error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST api/user/claim-earnings - Handles claiming daily earnings
router.post('/claim-earnings', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        if (!user.active_package) {
            return res.status(400).json({ success: false, message: "You do not have an active package." });
        }
        if (new Date() > user.package_expiry_date) {
            return res.status(400).json({ success: false, message: "Your package has expired." });
        }

        const now = new Date();
        const todayReset = new Date();
        todayReset.setUTCHours(0, 0, 0, 0); 

        if (user.last_claim_timestamp && user.last_claim_timestamp > todayReset) {
            return res.status(400).json({ success: false, message: "You have already claimed your profit for today." });
        }

        const dailyProfit = PACKAGES[user.active_package].dailyProfit;
        user.balance += dailyProfit;
        user.last_claim_timestamp = now;
        
        await user.save();
        res.json({ success: true, message: `Successfully claimed ${dailyProfit} PKR!`, newBalance: user.balance });

    } catch (error) {
        console.error("Claim earnings error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// ====================================================================
// --- NEW ROUTES FOR THE UPDATED PROFILE PAGE ---
// ====================================================================

/**
 * @route   GET api/user/account-summary
 * @desc    Get user's financial summary (deposits, withdrawals, profit)
 * @access  Private
 */
router.get('/account-summary', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Calculate total withdrawals from transaction history
        const totalWithdrawals = user.transactions
            .filter(tx => tx.type === 'withdrawal' && tx.status === 'completed')
            .reduce((sum, tx) => sum + (tx.amount || 0), 0);

        // Calculate lifetime profit
        const lifetimeProfit = (user.balance + totalWithdrawals) - user.totalDeposits;

        res.json({
            success: true,
            summary: {
                totalDeposits: user.totalDeposits,
                totalWithdrawals: totalWithdrawals,
                lifetimeProfit: lifetimeProfit
            }
        });

    } catch (err) {
        console.error('Error fetching account summary:', err.message);
        res.status(500).send('Server Error');
    }
});

/**
 * @route   GET api/user/recent-activity
 * @desc    Get user's last 5 transactions
 * @access  Private
 */
router.get('/recent-activity', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        // Get all transactions, sort them by date (newest first), and take the last 5
        const recentActivities = user.transactions
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5)
            .map(tx => ({
                date: tx.date,
                type: tx.type,
                amount: tx.amount,
                status: tx.status
            }));

        res.json({
            success: true,
            activities: recentActivities
        });

    } catch (err) {
        console.error('Error fetching recent activity:', err.message);
        res.status(500).send('Server Error');
    }
});


module.exports = router;
