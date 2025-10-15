const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

router.post('/telegram-login', async (req, res) => {
    const { initData } = req.body;
    if (!initData) {
        console.log("[ERROR] Request failed: initData was not provided.");
        return res.status(400).json({ message: 'Telegram initData is required.' });
    }

    try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user'));
        const startParam = params.get('start_param');

        // --- DEBUG LOG 1 ---
        console.log(`[DEBUG] Login attempt received for user: ${user.id}. Referral code received: '${startParam}'`);

        if (!user || !user.id) {
            console.log("[ERROR] User data or ID not found in initData.");
            return res.status(400).json({ message: 'User data not found in initData.' });
        }

        let dbUser = await User.findOne({ telegramId: user.id.toString() });

        if (dbUser) {
            console.log(`[DEBUG] Existing user found: ${dbUser.username}. Skipping referral logic.`);
        } else {
            console.log(`[DEBUG] This is a new user. Starting account creation process.`);
            let referredBy = null;
            let referrer = null;

            if (startParam) {
                referrer = await User.findOne({ referralCode: startParam });
                
                // --- DEBUG LOG 2 ---
                if (referrer) {
                    console.log(`[DEBUG] SUCCESS: Referrer found in database for code '${startParam}'. Referrer's username: ${referrer.username}`);
                    referredBy = referrer._id;
                } else {
                    console.log(`[DEBUG] FAILED: Referrer NOT found in database for code '${startParam}'.`);
                }
            } else {
                console.log(`[DEBUG] No referral code was provided with the link.`);
            }

            let newReferralCode = '';
            let isUnique = false;
            while (!isUnique) {
                newReferralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                if (!(await User.findOne({ referralCode: newReferralCode }))) {
                    isUnique = true;
                }
            }

            dbUser = new User({
                telegramId: user.id.toString(),
                firstName: user.first_name,
                lastName: user.last_name || '',
                username: user.username || `user${user.id}`,
                referredBy: referredBy,
                referralCode: newReferralCode
            });
            await dbUser.save();
            console.log(`[DEBUG] New user account successfully created with username: ${dbUser.username}`);

            if (referrer) {
                const oldCount = referrer.referralCount || 0;
                referrer.referralCount = oldCount + 1;
                await referrer.save();

                // --- DEBUG LOG 3 ---
                console.log(`[DEBUG] SUCCESS: Updated referral count for '${referrer.username}'. Old count: ${oldCount}, New count: ${referrer.referralCount}`);
            }
        }

        const payload = { id: dbUser._id, telegramId: dbUser.telegramId };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

        console.log(`[DEBUG] Login process complete for ${dbUser.username}. Sending token to frontend.`);

        res.json({
            message: "Logged in successfully.",
            token,
            user: {
                id: dbUser._id,
                username: dbUser.username || dbUser.firstName,
                balance: dbUser.balance,
                activePackage: dbUser.active_package,
                packageExpiry: dbUser.package_expiry_date
            }
        });

    } catch (error) {
        console.error("[FATAL SERVER ERROR] The /telegram-login route crashed:", error);
        res.status(500).json({ message: "Server error during authentication." });
    }
});

module.exports = router;
