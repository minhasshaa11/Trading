const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

router.post('/telegram-login', async (req, res) => {
    const { initData } = req.body;

    // --- LOG 1: RAW DATA ---
    // This shows us the absolute raw data string received from Telegram.
    console.log(`[RAW INIT DATA RECEIVED]: ${initData}`);

    if (!initData) {
        console.log("[ERROR] Request failed: initData was not provided.");
        return res.status(400).json({ message: 'Telegram initData is required.' });
    }

    try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user'));
        const startParam = params.get('start_param');

        // --- LOG 2: PARSED DATA ---
        console.log(`[DEBUG] Login attempt for user ID: ${user ? user.id : 'N/A'}. Parsed referral code: '${startParam}'`);

        if (!user || !user.id) {
            console.log("[ERROR] User data or ID could not be parsed from initData.");
            return res.status(400).json({ message: 'User data not found in initData.' });
        }

        let dbUser = await User.findOne({ telegramId: user.id.toString() });

        if (dbUser) {
            console.log(`[DEBUG] Existing user found: ${dbUser.username}. Skipping referral logic.`);
        } else {
            console.log(`[DEBUG] New user detected. Starting account creation...`);
            let referredBy = null;
            let referrer = null;

            if (startParam) {
                referrer = await User.findOne({ referralCode: startParam });
                
                // --- LOG 3: REFERRER CHECK ---
                if (referrer) {
                    console.log(`[DEBUG] SUCCESS: Found referrer in DB with code '${startParam}'. Referrer: ${referrer.username}`);
                    referredBy = referrer._id;
                } else {
                    console.log(`[DEBUG] FAILED: Could NOT find a referrer in DB with code '${startParam}'.`);
                }
            } else {
                console.log(`[DEBUG] No referral code was provided in the link.`);
            }

            // (User creation logic...)
            let newReferralCode = '';
            let isUnique = false;
            while (!isUnique) {
                newReferralCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
                if (!(await User.findOne({ referralCode: newReferralCode }))) { isUnique = true; }
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
            console.log(`[DEBUG] New user account created in DB: ${dbUser.username}`);

            if (referrer) {
                const oldCount = referrer.referralCount || 0;
                referrer.referralCount = oldCount + 1;
                await referrer.save();

                // --- LOG 4: REFERRAL COUNT UPDATE ---
                console.log(`[DEBUG] SUCCESS: Updated referral count for '${referrer.username}'. New count: ${referrer.referralCount}`);
            }
        }

        const payload = { id: dbUser._id, telegramId: dbUser.telegramId };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });

        console.log(`[DEBUG] Process complete. Sending token for ${dbUser.username}.`);

        res.json({
            message: "Logged in successfully.",
            token,
            user: {
                id: dbUser._id,
                username: dbUser.username || dbUser.firstName,
                balance: dbUser.balance,
                active_package: dbUser.active_package,
                package_expiry_date: dbUser.package_expiry_date
            }
        });

    } catch (error) {
        console.error("[FATAL SERVER ERROR] The /telegram-login route crashed:", error);
        res.status(500).json({ message: "Server error during authentication." });
    }
});

module.exports = router;
