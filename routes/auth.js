const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const crypto = require("crypto");

/* FIX 2: Maximum age for initData (5 minutes) */
var MAX_AUTH_AGE_SECONDS = 300;

/* FIX 8: Max attempts for referral code generation */
var MAX_CODE_ATTEMPTS = 10;

/**
 * Validate Telegram initData
 * FIX 1: Timing-safe comparison
 * FIX 2: auth_date expiry check
 */
function validateTelegramData(initData) {
    var BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
        console.error("FATAL: BOT_TOKEN environment variable is not set!");
        return false;
    }

    try {
        var params = new URLSearchParams(initData);
        var hash = params.get("hash");
        if (!hash) return false;

        /* FIX 2: Check auth_date is not too old */
        var authDate = parseInt(params.get("auth_date"));
        if (!authDate || isNaN(authDate)) return false;

        var now = Math.floor(Date.now() / 1000);
        if (now - authDate > MAX_AUTH_AGE_SECONDS) {
            console.warn("Auth data expired. Age:", now - authDate, "seconds");
            return false;
        }

        params.delete("hash");

        var dataCheckString = Array.from(params.keys())
            .sort()
            .map(function (key) {
                return key + "=" + params.get(key);
            })
            .join("\n");

        var secretKey = crypto
            .createHmac("sha256", "WebAppData")
            .update(BOT_TOKEN)
            .digest();
        var calculatedHmac = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        /* FIX 1: Timing-safe comparison */
        try {
            var hashBuffer = Buffer.from(hash, "hex");
            var calcBuffer = Buffer.from(calculatedHmac, "hex");
            if (hashBuffer.length !== calcBuffer.length) return false;
            return crypto.timingSafeEqual(hashBuffer, calcBuffer);
        } catch (e) {
            return false;
        }
    } catch (e) {
        console.error("Telegram validation error:", e.message);
        return false;
    }
}

/* FIX 8: Generate unique referral code with max attempts */
async function generateReferralCode() {
    for (var attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        var code =
            "REF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
        var existing = await User.findOne({ referralCode: code }).select(
            "_id"
        );
        if (!existing) return code;
    }
    /* Fallback: use longer code if short ones keep colliding */
    return (
        "REF-" + crypto.randomBytes(8).toString("hex").toUpperCase()
    );
}

// =================================================================================
// TELEGRAM LOGIN & REGISTRATION
// =================================================================================
router.post("/telegram-login", async function (req, res) {
    var initData = req.body.initData;

    if (!initData) {
        return res
            .status(400)
            .json({ message: "Telegram initData is required." });
    }

    try {
        // --- 1. Validate Telegram Data ---
        if (!validateTelegramData(initData)) {
            return res
                .status(401)
                .json({ message: "Invalid or expired Telegram data." });
        }

        // --- 2. Parse User Data ---
        var params = new URLSearchParams(initData);
        var userData;
        try {
            userData = JSON.parse(params.get("user"));
        } catch (e) {
            return res
                .status(400)
                .json({ message: "Invalid user data format." });
        }

        var startParam = params.get("start_param");

        if (!userData || !userData.id) {
            return res
                .status(400)
                .json({ message: "User data not found in initData." });
        }

        var telegramId = String(userData.id);

        // --- 3. Find or Create User ---
        /* FIX 3: Use findOneAndUpdate with upsert-like pattern to prevent
           race condition on simultaneous first login from multiple devices */
        var dbUser = await User.findOne({ telegramId: telegramId });

        if (!dbUser) {
            var referredBy = null;

            /* FIX 4: Process referral with self-referral prevention */
            if (startParam && typeof startParam === "string") {
                var referrer = await User.findOne({
                    referralCode: startParam,
                });
                if (referrer) {
                    /* FIX 4: Prevent self-referral (compare telegram IDs) */
                    if (referrer.telegramId !== telegramId) {
                        referredBy = referrer._id;

                        /* FIX 5: Atomic referral count increment */
                        await User.findByIdAndUpdate(referrer._id, {
                            $inc: { referralCount: 1 },
                        });
                    }
                }
            }

            var newReferralCode = await generateReferralCode();

            /* FIX 3: Use findOneAndUpdate to atomically create user
               only if telegramId doesn't exist yet */
            dbUser = await User.findOneAndUpdate(
                { telegramId: telegramId },
                {
                    $setOnInsert: {
                        telegramId: telegramId,
                        firstName: userData.first_name || "",
                        lastName: userData.last_name || "",
                        username: userData.username || null,
                        referredBy: referredBy,
                        referralCode: newReferralCode,
                    },
                },
                {
                    upsert: true,
                    new: true,
                }
            );
        } else {
            /* Existing user: optionally update name if changed on Telegram */
            var updates = {};
            if (
                userData.first_name &&
                userData.first_name !== dbUser.firstName
            ) {
                updates.firstName = userData.first_name;
            }
            if (
                userData.username &&
                userData.username !== dbUser.username
            ) {
                updates.username = userData.username;
            }
            if (Object.keys(updates).length > 0) {
                await User.findByIdAndUpdate(dbUser._id, {
                    $set: updates,
                });
                /* Update local reference */
                if (updates.firstName) dbUser.firstName = updates.firstName;
                if (updates.username) dbUser.username = updates.username;
            }
        }

        // --- 4. Create JWT Token ---
        var payload = {
            id: dbUser._id,
            telegramId: dbUser.telegramId,
        };

        /* FIX 6: Shorter token expiry */
        var token = jwt.sign(payload, process.env.JWT_SECRET, {
            expiresIn: "7d",
        });

        // --- 5. Send Response ---
        res.json({
            message: "Logged in successfully.",
            token: token,
            user: {
                id: dbUser._id,
                username: dbUser.username || dbUser.firstName || "User",
                balance: dbUser.balance || 0,
                activePackage: dbUser.active_package || null,
                packageExpiry: dbUser.package_expiry_date || null,
            },
        });
    } catch (error) {
        /* FIX: Don't log full error object in production */
        console.error(
            "Telegram Login Error:",
            error.message
        );

        /* Handle duplicate key error (race condition fallback) */
        if (error.code === 11000) {
            /* Another request already created this user, just find and login */
            try {
                var existingUser = await User.findOne({
                    telegramId: String(req.body.initData ? JSON.parse(new URLSearchParams(req.body.initData).get("user")).id : ""),
                });
                if (existingUser) {
                    var fallbackToken = jwt.sign(
                        {
                            id: existingUser._id,
                            telegramId: existingUser.telegramId,
                        },
                        process.env.JWT_SECRET,
                        { expiresIn: "7d" }
                    );
                    return res.json({
                        message: "Logged in successfully.",
                        token: fallbackToken,
                        user: {
                            id: existingUser._id,
                            username:
                                existingUser.username ||
                                existingUser.firstName ||
                                "User",
                            balance: existingUser.balance || 0,
                            activePackage:
                                existingUser.active_package || null,
                            packageExpiry:
                                existingUser.package_expiry_date || null,
                        },
                    });
                }
            } catch (e) {
                /* Fall through to generic error */
            }
        }

        res.status(500).json({
            message: "Server error during authentication.",
        });
    }
});

module.exports = router;
