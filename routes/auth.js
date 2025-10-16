Const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

// =================================================================================
// --- NEW: TELEGRAM LOGIN & REGISTRATION ROUTE ---
// This single endpoint handles both login and registration for Telegram users.
// =================================================================================
router.post('/telegram-login', async (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ message: 'Telegram initData is required.' });
    }

    try {
        // --- 1. Validate Telegram Data (Critical for Security) ---
        if (!validateTelegramData(initData)) {
            return res.status(401).json({ message: 'Invalid or tampered Telegram data.' });
        }

        // --- 2. Parse User Data & Referral Code ---
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user'));
        const startParam = params.get('start_param'); // This is the referral code from the bot link

        if (!user || !user.id) {
            return res.status(400).json({ message: 'User data not found in initData.' });
        }

        // --- 3. Find Existing User or Prepare to Create a New One ---
        let dbUser = await User.findOne({ telegramId: user.id.toString() });

        // If the user does not exist, create them
        if (!dbUser) {
            let referredBy = null;
            let referrer = null;

            // Use the start_param from Telegram as the referral code
            if (startParam) {
                referrer = await User.findOne({ referralCode: startParam });
                if (referrer) {
                    referredBy = referrer._id;
                }
            }

            // Generate a unique referral code for the new user
            let isUnique = false;
            let newReferralCode = '';
            while (!isUnique) {
                newReferralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                const existingUser = await User.findOne({ referralCode: newReferralCode });
                if (!existingUser) {
                    isUnique = true;
                }
            }

            dbUser = new User({
                telegramId: user.id.toString(),
                firstName: user.first_name,
                lastName: user.last_name || '',
                username: user.username, // Can be undefined, which is fine
                referredBy: referredBy,
                referralCode: newReferralCode
            });

            await dbUser.save();

            // If there was a referrer, update their count
            if (referrer) {
                referrer.referralCount += 1;
                await referrer.save();
            }
        }

        // --- 4. Create and Sign JWT Token ---
        const payload = {
            id: dbUser._id,
            telegramId: dbUser.telegramId
        };

        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

        // --- 5. Send Token and User Data to Frontend ---
        res.json({
            message: "Logged in successfully.",
            token,
            user: {
                id: dbUser._id,
                username: dbUser.username || dbUser.firstName, // Fallback to firstName if no username
                balance: dbUser.balance,
                activePackage: dbUser.active_package,
                packageExpiry: dbUser.package_expiry_date
            }
        });

    } catch (error) {
        console.error("Telegram Login Error:", error);
        res.status(500).json({ message: "Server error during authentication." });
    }
});


/**
 * NEW: Helper function to validate initData against your bot token.
 * This ensures the request is authentic and came from Telegram.
 * @param {string} initData The string from Telegram.WebApp.initData
 * @returns {boolean}
 */
function validateTelegramData(initData) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
        console.error("FATAL: BOT_TOKEN environment variable is not set!");
        return false;
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = Array.from(params.keys())
        .sort()
        .map(key => `${key}=${params.get(key)}`)
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    return hmac === hash;
}


// =================================================================================
// --- OLD ROUTES ---
// You can now delete your old '/register' and '/login' routes if you are
// moving completely to the Telegram Mini App login flow.
// =================================================================================


module.exports = router;
