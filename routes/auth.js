const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

// --- THE ONLY AUTH ROUTE YOU NEED NOW ---
router.post('/telegram-login', async (req, res) => {
    try {
        const { telegramUser, telegramStartParam } = req.body;

        if (!telegramUser || !telegramUser.id) {
            return res.status(400).json({ success: false, message: 'Invalid Telegram user data.' });
        }

        // Find a user by their unique Telegram ID
        let user = await User.findOne({ telegramId: telegramUser.id });

        // If the user does NOT exist, create a new account
        if (!user) {
            let referredBy = null;
            let referrer = null;
            
            if (telegramStartParam) {
                referrer = await User.findOne({ referralCode: telegramStartParam });
                if (referrer) {
                    referredBy = referrer._id;
                }
            }

            let isUnique = false;
            let referralCode = '';
            while (!isUnique) {
                referralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const existingUser = await User.findOne({ referralCode: referralCode });
                if (!existingUser) {
                    isUnique = true;
                }
            }

            // Create the new user object
            user = new User({
                telegramId: telegramUser.id,
                username: telegramUser.username || `user${telegramUser.id}`,
                firstName: telegramUser.first_name,
                lastName: telegramUser.last_name,
                referralCode: referralCode,
                referredBy: referredBy,
                // --- THIS IS THE FIX: Add the missing required fields ---
                totalDeposits: 0,
                totalTradeVolume: 0
                // ----------------------------------------------------
            });
            
            await user.save();

            if (referrer) {
                // Use findByIdAndUpdate for a more robust update
                await User.findByIdAndUpdate(referrer._id, { $inc: { referralCount: 1 } });
            }
        }

        // --- LOGIN THE USER (either existing or newly created) ---
        const payload = { 
            id: user._id,
            username: user.username 
        };
        
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ 
            success: true,
            message: "Logged in successfully.", 
            token
        });

    } catch (error) {
        console.error("Telegram Login Error:", error);
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

module.exports = router;
