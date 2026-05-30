const express = require("express");
const router = express.Router();
const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

// Configuration
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NOWPAYMENTS_URL = "https://api.nowpayments.io/v1";
const MY_SERVER_WEBHOOK_URL =
    (process.env.RENDER_URL || "https://trading-app-2s4e.onrender.com") +
    "/api/deposit/ipn-callback";

const SERVICE_FEE_PERCENT = 0.01;

/* FIX 5: Deposit limits */
var MIN_DEPOSIT = 5;
var MAX_DEPOSIT = 50000;

/* FIX 9: Max pending deposits per user */
var MAX_PENDING_DEPOSITS = 5;

var apiHeaders = {
    "x-api-key": NOWPAYMENTS_API_KEY,
    "Content-Type": "application/json",
};

/* FIX 8: Validate secrets at startup */
if (!NOWPAYMENTS_API_KEY) {
    console.error("FATAL: NOWPAYMENTS_API_KEY is not set!");
}
if (!NOWPAYMENTS_IPN_SECRET) {
    console.error("FATAL: NOWPAYMENTS_IPN_SECRET is not set!");
}

/* FIX 4: Timing-safe HMAC comparison */
function verifySignature(body, receivedSignature) {
    if (!NOWPAYMENTS_IPN_SECRET || !receivedSignature) return false;

    var sortedBody = Object.keys(body)
        .sort()
        .reduce(function (obj, key) {
            obj[key] = body[key];
            return obj;
        }, {});

    var hmac = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET);
    hmac.update(JSON.stringify(sortedBody));
    var calculatedSignature = hmac.digest("hex");

    /* Timing-safe comparison to prevent timing attacks */
    try {
        var sigBuffer = Buffer.from(receivedSignature, "hex");
        var calcBuffer = Buffer.from(calculatedSignature, "hex");
        if (sigBuffer.length !== calcBuffer.length) return false;
        return crypto.timingSafeEqual(sigBuffer, calcBuffer);
    } catch (e) {
        return false;
    }
}

/* Allowed currencies whitelist */
var ALLOWED_CURRENCIES = [
    "usdtbsc",
    "ltc",
    "maticmainnet",
    "algo",
    "usdttrc20",
];

// ==========================================
// 1. CREATE DEPOSIT
// ==========================================
router.post("/create_deposit", authMiddleware, async function (req, res) {
    var amount = req.body.amount;
    var currency = req.body.currency;

    if (!amount || !currency) {
        return res.status(400).json({
            success: false,
            message: "Amount and currency are required.",
        });
    }

    /* Validate currency */
    if (ALLOWED_CURRENCIES.indexOf(currency) === -1) {
        return res.status(400).json({
            success: false,
            message: "Invalid currency selected.",
        });
    }

    var originalAmount = parseFloat(amount);

    /* FIX 5: Validate deposit amount */
    if (isNaN(originalAmount) || originalAmount < MIN_DEPOSIT) {
        return res.status(400).json({
            success: false,
            message: "Minimum deposit is $" + MIN_DEPOSIT + ".",
        });
    }
    if (originalAmount > MAX_DEPOSIT) {
        return res.status(400).json({
            success: false,
            message: "Maximum deposit is $" + MAX_DEPOSIT + ".",
        });
    }

    try {
        var user = await User.findById(req.user.id);
        if (!user)
            return res
                .status(404)
                .json({ success: false, message: "User not found" });

        /* FIX 9: Limit pending deposits */
        var pendingCount = 0;
        if (user.transactions) {
            for (var i = 0; i < user.transactions.length; i++) {
                if (
                    user.transactions[i].type === "deposit" &&
                    user.transactions[i].status === "pending"
                ) {
                    pendingCount++;
                }
            }
        }
        if (pendingCount >= MAX_PENDING_DEPOSITS) {
            return res.status(400).json({
                success: false,
                message:
                    "You have too many pending deposits. Please complete or cancel existing ones first.",
            });
        }

        var amountToPay = originalAmount + originalAmount * SERVICE_FEE_PERCENT;

        var response = await axios.post(
            NOWPAYMENTS_URL + "/payment",
            {
                price_amount: amountToPay,
                price_currency: "usd",
                pay_currency: currency,
                order_id: user.id,
                order_description: "USD Deposit for " + (user.username || user._id),
                ipn_callback_url: MY_SERVER_WEBHOOK_URL,
                is_fee_paid_by_user: true,
            },
            { headers: apiHeaders }
        );

        var paymentId = response.data.payment_id;
        var payAddress = response.data.pay_address;
        var payAmount = response.data.pay_amount;

        /* FIX 6: Include type: 'deposit' */
        user.transactions.push({
            txid: String(paymentId),
            type: "deposit",
            amount: originalAmount,
            currency: "USD",
            status: "pending",
            date: new Date(),
        });

        await user.save();

        res.json({
            success: true,
            payment_id: paymentId,
            deposit_address: payAddress,
            amount_expected: payAmount,
        });
    } catch (error) {
        var errorMessage = "Failed to generate deposit address.";
        if (error.response) {
            errorMessage =
                error.response.data.message ||
                "API Error: " + error.response.status;
            console.error("NowPayments API Error:", error.response.data);
        } else {
            console.error("Network/Internal Error:", error.message);
        }
        res.status(500).json({ success: false, message: errorMessage });
    }
});

// ==========================================
// 2. VERIFY STATUS
// ==========================================
router.post("/verify", authMiddleware, async function (req, res) {
    var payment_id = req.body.payment_id;

    if (!payment_id) {
        return res.status(400).json({
            success: false,
            message: "Payment ID is required.",
        });
    }

    /* Sanitize payment_id */
    var paymentIdStr = String(payment_id);

    try {
        /* FIX 1: Atomic update to prevent race condition on verify.
           Use findOneAndUpdate with condition that transaction status is NOT completed. */
        var apiResponse = await axios.get(
            NOWPAYMENTS_URL + "/payment/" + paymentIdStr,
            { headers: apiHeaders }
        );
        var paymentStatus = apiResponse.data.payment_status;

        if (paymentStatus === "finished" || paymentStatus === "confirmed") {
            /* FIX 3: Verify the actual amount from NowPayments matches */
            var actualPriceAmount = parseFloat(apiResponse.data.price_amount) || 0;
            var expectedFeeMultiplier = 1 + SERVICE_FEE_PERCENT;

            /* Atomic: only update if status is still pending */
            var result = await User.findOneAndUpdate(
                {
                    _id: req.user.id,
                    "transactions.txid": paymentIdStr,
                    "transactions.status": { $ne: "completed" },
                },
                {
                    $set: { "transactions.$.status": "completed" },
                    $inc: {
                        balance: Math.floor(
                            (actualPriceAmount / expectedFeeMultiplier) * 100
                        ) / 100,
                    },
                },
                { new: true }
            );

            if (!result) {
                /* Either user not found, tx not found, or already completed */
                var user = await User.findById(req.user.id);
                if (!user)
                    return res
                        .status(404)
                        .json({ success: false, message: "User not found" });

                var tx = user.transactions.find(function (t) {
                    return t.txid === paymentIdStr;
                });
                if (!tx)
                    return res.status(404).json({
                        success: false,
                        message: "Transaction not found.",
                    });
                if (tx.status === "completed")
                    return res.json({
                        success: true,
                        message: "Deposit already confirmed!",
                        status: "completed",
                    });
            }

            return res.json({
                success: true,
                message: "Deposit Successful! Balance Updated.",
                status: "completed",
            });
        } else if (
            paymentStatus === "failed" ||
            paymentStatus === "expired"
        ) {
            /* Mark as failed atomically */
            await User.findOneAndUpdate(
                {
                    _id: req.user.id,
                    "transactions.txid": paymentIdStr,
                    "transactions.status": "pending",
                },
                { $set: { "transactions.$.status": "failed" } }
            );

            return res.json({
                success: false,
                message: "Payment failed or expired.",
                status: paymentStatus,
            });
        }

        res.json({
            success: true,
            message: "Payment processing. Please wait for confirmations.",
            status: paymentStatus,
        });
    } catch (error) {
        console.error("Manual Verification Error:", error.message);
        res.status(500).json({
            success: false,
            message: "Error checking payment status.",
        });
    }
});

// ==========================================
// 3. AUTOMATED WEBHOOK (IPN)
// ==========================================
router.post("/ipn-callback", async function (req, res) {
    try {
        var receivedSignature = req.headers["x-nowpayments-sig"];

        /* FIX 4: Timing-safe signature verification */
        if (!verifySignature(req.body, receivedSignature)) {
            console.error(
                "Security Warning: IPN signature verification failed."
            );
            return res.status(401).send("Signature verification failed");
        }

        var paymentStatus = req.body.payment_status;
        var paymentId = req.body.payment_id;
        var orderId = req.body.order_id;

        /* Validate required fields */
        if (!paymentId || !orderId) {
            return res.status(400).send("Missing required fields");
        }

        /* Validate orderId is a valid ObjectId */
        if (!mongoose.Types.ObjectId.isValid(orderId)) {
            return res.status(400).send("Invalid order ID");
        }

        if (
            paymentStatus === "finished" ||
            paymentStatus === "confirmed"
        ) {
            /* FIX 3: Get actual amount from NowPayments response */
            var actualPriceAmount = parseFloat(req.body.price_amount) || 0;
            var expectedFeeMultiplier = 1 + SERVICE_FEE_PERCENT;
            var creditAmount =
                Math.floor(
                    (actualPriceAmount / expectedFeeMultiplier) * 100
                ) / 100;

            /* FIX 2: Atomic update to prevent double credit on IPN retry/replay */
            var result = await User.findOneAndUpdate(
                {
                    _id: orderId,
                    "transactions.txid": String(paymentId),
                    "transactions.status": { $ne: "completed" },
                },
                {
                    $set: { "transactions.$.status": "completed" },
                    $inc: { balance: creditAmount },
                },
                { new: true }
            );

            if (result) {
                console.log(
                    "IPN: Credited $" +
                        creditAmount +
                        " to User " +
                        orderId
                );
            } else {
                console.log(
                    "IPN: Already processed or not found - Payment " +
                        paymentId
                );
            }
        } else if (
            paymentStatus === "failed" ||
            paymentStatus === "expired"
        ) {
            await User.findOneAndUpdate(
                {
                    _id: orderId,
                    "transactions.txid": String(paymentId),
                    "transactions.status": "pending",
                },
                { $set: { "transactions.$.status": "failed" } }
            );
        }

        res.status(200).send("OK");
    } catch (error) {
        console.error("IPN Process Error:", error.message);
        res.status(500).send("Internal Server Error");
    }
});

// ==========================================
// 4. GET HISTORY
// ==========================================
router.get("/history", authMiddleware, async function (req, res) {
    try {
        var user = await User.findById(req.user.id).select("transactions");
        if (!user)
            return res
                .status(404)
                .json({ success: false, message: "User not found." });

        /* FIX 7: Filter only deposit transactions and don't mutate original */
        var deposits = [];
        if (user.transactions) {
            for (var i = 0; i < user.transactions.length; i++) {
                var tx = user.transactions[i];
                if (tx.type === "deposit") {
                    deposits.push(tx);
                }
            }
        }

        deposits.sort(function (a, b) {
            return new Date(b.date) - new Date(a.date);
        });

        res.json({ success: true, history: deposits });
    } catch (error) {
        console.error("Deposit history error:", error.message);
        res.status(500).json({
            success: false,
            message: "Internal server error.",
        });
    }
});

module.exports = router;
