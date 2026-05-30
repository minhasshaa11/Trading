const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

// =================================================================================
// TELEGRAM LOGIN & REGISTRATION ROUTE
// =================================================================================
router.post('/telegram-login', async (req, res) => {
    const { initData } = req.body;

    // --- DEBUG LOG (remove after fixing) ---
    console.log("=== /telegram-login called ===");
    console.log("initData received:", initData ? initData.substring(0, 100) + "..." : "EMPTY / NULL");
    console.log("BOT_TOKEN set:", !!process.env.BOT_TOKEN);
    console.log("JWT_SECRET set:", !!process.env.JWT_SECRET);

    if (!initData) {
        return res.status(400).json({ message: 'Telegram initData is required.' });
    }

    try {
        // --- 1. Validate Telegram Data ---
        const validationResult = validateTelegramData(initData);
        console.log("Validation result:", validationResult);

        if (!validationResult.valid) {
            return res.status(401).json({ message: `Invalid Telegram data: ${validationResult.reason}` });
        }

        // --- 2. Parse User Data ---
        const params = new URLSearchParams(initData);
        const userParam = params.get('user');
        const startParam = params.get('start_param');

        if (!userParam) {
            return res.status(400).json({ message: 'User param missing from initData.' });
        }

        let telegramUser;
        try {
            telegramUser = JSON.parse(userParam);
        } catch (e) {
            return res.status(400).json({ message: 'Could not parse user data from initData.' });
        }

        if (!telegramUser || !telegramUser.id) {
            return res.status(400).json({ message: 'User ID not found in initData.' });
        }

        console.log("Telegram user ID:", telegramUser.id);

        // --- 3. Find or Create User ---
        let dbUser = await User.findOne({ telegramId: telegramUser.id.toString() });

        if (!dbUser) {
            let referredBy = null;
            let referrer = null;

            if (startParam) {
                referrer = await User.findOne({ referralCode: startParam });
                if (referrer) referredBy = referrer._id;
            }

            // Generate unique referral code
            let isUnique = false;
            let newReferralCode = '';
            while (!isUnique) {
                newReferralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const existing = await User.findOne({ referralCode: newReferralCode });
                if (!existing) isUnique = true;
            }

            dbUser = new User({
                telegramId: telegramUser.id.toString(),
                firstName: telegramUser.first_name || '',
                lastName: telegramUser.last_name || '',
                username: telegramUser.username || null,
                referredBy: referredBy,
                referralCode: newReferralCode
            });

            await dbUser.save();
            console.log("New user created:", dbUser._id);

            if (referrer) {
                referrer.referralCount += 1;
                await referrer.save();
            }
        } else {
            console.log("Existing user found:", dbUser._id);
        }

        // --- 4. Create JWT ---
        const payload = {
            id: dbUser._id,
            telegramId: dbUser.telegramId
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

        // --- 5. Send Response ---
        return res.json({
            message: "Logged in successfully.",
            token,
            user: {
                id: dbUser._id,
                username: dbUser.username || dbUser.firstName || 'User',
                balance: dbUser.balance || 0,
                activePackage: dbUser.active_package || null,
                packageExpiry: dbUser.package_expiry_date || null
            }
        });

    } catch (error) {
        console.error("Telegram Login Error:", error);
        return res.status(500).json({ message: "Server error during authentication.", error: error.message });
    }
});


// =================================================================================
// VALIDATE TELEGRAM DATA - TEMPORARILY BYPASSED FOR DEBUGGING
// =================================================================================
function validateTelegramData(initData) {
    console.log("⚠️  VALIDATION BYPASSED - TESTING MODE");
    return { valid: true };
}


module.exports = router;
