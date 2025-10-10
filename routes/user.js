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

// This route provides basic user info (Unchanged)
router.get('/info', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        res.json({ success: true, user: user });
    } catch (error) {
        console.error("Error fetching user info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route provides the user's referral data (Unchanged)
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
    } catch (error) {
        console.error("Error fetching referral info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route handles changing the user's password (Unchanged)
router.post('/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmNewPassword) { return res.status(400).json({ success: false, message: 'All fields are required.' }); }
    if (newPassword !== confirmNewPassword) { return res.status(400).json({ success: false, message: 'New passwords do not match.' }); }
    if (newPassword.length < 6) { return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' }); }

    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) { return res.status(400).json({ success: false, message: 'Incorrect current password.' }); }
        user.password = newPassword;
        await user.save();
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        console.error("Change password error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// This route handles purchasing an investment package (Unchanged)
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

// This route handles claiming daily earnings (Unchanged)
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

// --- NEW ROUTE TO GET A USER'S REFERRALS ---
router.get('/my-referrals', authMiddleware, async (req, res) => {
    try {
        const referrals = await User.find({ referredBy: req.user.id })
                                    .select('username createdAt') // Only get the username and join date
                                    .sort({ createdAt: -1 }); // Show the newest first

        res.json({ success: true, referrals: referrals });
    } catch (error) {
        console.error("Error fetching referrals:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});
// ---------------------------------------------

module.exports = router;
