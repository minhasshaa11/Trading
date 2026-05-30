const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

// =================================================================================
// TELEGRAM LOGIN & REGISTRATION
// =================================================================================
router.post('/telegram-login', async (req, res) => {
    const { initData } = req.body;

    if (!initData) {
        return res.status(400).json({ message: 'Telegram initData is required.' });
    }

    try {
        // 1. Validate
        const validationResult = validateTelegramData(initData);
        if (!validationResult.valid) {
            return res.status(401).json({ message: `Invalid Telegram data: ${validationResult.reason}` });
        }

        // 2. Parse user
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
            return res.status(400).json({ message: 'Could not parse user data.' });
        }

        if (!telegramUser || !telegramUser.id) {
            return res.status(400).json({ message: 'User ID not found in initData.' });
        }

        // 3. Find or create user
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

            if (referrer) {
                referrer.referralCount += 1;
                await referrer.save();
            }
        }

        // 4. JWT
        const token = jwt.sign(
            { id: dbUser._id, telegramId: dbUser.telegramId },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        // 5. Response
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
        return res.status(500).json({ message: "Server error during authentication." });
    }
});

// =================================================================================
// VALIDATE TELEGRAM DATA
// =================================================================================
function validateTelegramData(initData) {
    const BOT_TOKEN = process.env.BOT_TOKEN;

    if (!BOT_TOKEN) {
        return { valid: false, reason: "BOT_TOKEN not configured." };
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return { valid: false, reason: "Hash missing." };

        params.delete('hash');

        const dataCheckString = Array.from(params.keys())
            .sort()
            .map(key => `${key}=${params.get(key)}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const hmac = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (hmac !== hash) return { valid: false, reason: "Hash mismatch." };

        return { valid: true };

    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

module.exports = router;
