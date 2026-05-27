const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto'); // Built-in Node module for secure signature verification
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Configuration
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET; // The key from your dashboard image
const NOWPAYMENTS_URL = 'https://api.nowpayments.io/v1';

// Webhook destination URL configured exactly to your Render app
const MY_SERVER_WEBHOOK_URL = "https://trading-app-2s4e.onrender.com/api/deposit/ipn-callback";

const SERVICE_FEE_PERCENT = 0.01; // 1% Total (0.5% NowPayments + 0.5% Safety buffer)

const apiHeaders = {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
};

// ==========================================
// 1. CREATE DEPOSIT (Strictly USD Base)
// ==========================================
router.post("/create_deposit", authMiddleware, async (req, res) => {
    const { amount, currency } = req.body; // currency = e.g., 'usdttrc20'

    if (!amount || !currency) {
        return res.status(400).json({ success: false, message: "Amount and currency are required." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        const originalAmount = parseFloat(amount);
        const amountToPay = originalAmount + (originalAmount * SERVICE_FEE_PERCENT);

        // Ask NowPayments to create invoice
        const response = await axios.post(`${NOWPAYMENTS_URL}/payment`, {
            price_amount: amountToPay, 
            price_currency: 'usd', // Continuing strictly with USD values
            pay_currency: currency,
            order_id: user.id,
            order_description: `USD Deposit for ${user.username}`,
            ipn_callback_url: MY_SERVER_WEBHOOK_URL, // Passes your Render link to NowPayments dynamically
            is_fee_paid_by_user: true 
        }, { headers: apiHeaders });

        const { payment_id, pay_address, pay_amount } = response.data;

        // Save the transaction record natively as USD
        user.transactions.push({
            txid: payment_id,
            amount: originalAmount, 
            currency: 'USD',
            status: 'pending',
            date: new Date()
        });

        await user.save();

        res.json({
            success: true,
            payment_id: payment_id,
            deposit_address: pay_address,
            amount_expected: pay_amount
        });

    } catch (error) {
        let errorMessage = "Failed to generate deposit address.";
        if (error.response) {
            errorMessage = error.response.data.message || `API Error: ${error.response.status}`;
            console.error("NowPayments API Error:", error.response.data);
        } else {
            console.error("Network/Internal Error:", error.message);
        }
        res.status(500).json({ success: false, message: errorMessage });
    }
});

// ==========================================
// 2. VERIFY STATUS (Secure Manual Fallback Check)
// ==========================================
router.post("/verify", authMiddleware, async (req, res) => {
    const { payment_id } = req.body;

    if (!payment_id) {
        return res.status(400).json({ success: false, message: "Payment ID is required." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        const transaction = user.transactions.find(t => t.txid === payment_id);
        
        if (!transaction) {
            return res.status(404).json({ success: false, message: "Transaction record not found." });
        }

        // Fixed checking vulnerability logic to avoid double balance updates
        if (transaction.status === 'completed') {
             return res.json({ success: true, message: "Deposit already confirmed!", status: 'completed' });
        }

        const response = await axios.get(`${NOWPAYMENTS_URL}/payment/${payment_id}`, { headers: apiHeaders });
        const status = response.data.payment_status; 

        if (status === 'finished' || status === 'confirmed') {
            // Tight block checking to prevent multi-call balance exploitation
            if (transaction.status !== 'completed') {
                transaction.status = 'completed';
                user.balance = (user.balance || 0) + transaction.amount;
                await user.save();
            }
            
            return res.json({ 
                success: true, 
                message: "Deposit Successful! USD Balance Updated.", 
                status: 'completed' 
            });
        } else if (status === 'failed' || status === 'expired') {
            transaction.status = 'failed';
            await user.save();
            return res.json({ success: false, message: "Payment failed or expired.", status: status });
        }

        res.json({ 
            success: true, 
            message: "Payment processing. Please wait for confirmations.", 
            status: status 
        });

    } catch (error) {
        console.error("Manual Verification Error:", error.message);
        res.status(500).json({ success: false, message: "Error checking payment status." });
    }
});

// ==========================================
// 3. AUTOMATED WEBHOOK (IPN Endpoint Listener)
// ==========================================
// NOTE: Public endpoint accessed directly by NowPayments. Keep authMiddleware OFF here.
router.post("/ipn-callback", async (req, res) => {
    try {
        const receivedSignature = req.headers['x-nowpayments-sig'];
        if (!receivedSignature) return res.status(400).send('Missing signature header');

        // Cryptographic integrity validation: Sort payload keys alphabetically
        const sortedBody = Object.keys(req.body).sort().reduce((obj, key) => {
            obj[key] = req.body[key];
            return obj;
        }, {});

        const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET);
        hmac.update(JSON.stringify(sortedBody));
        const calculatedSignature = hmac.digest('hex');

        // Block unauthorized/spoofed callback attempts
        if (receivedSignature !== calculatedSignature) {
            console.error("Security Warning: IPN Verification mismatch signature block triggered.");
            return res.status(401).send('Signature match failed');
        }

        const { payment_status, payment_id, order_id } = req.body;

        if (payment_status === 'finished' || payment_status === 'confirmed') {
            const user = await User.findById(order_id);
            if (!user) return res.status(404).send('User reference not found');

            const transaction = user.transactions.find(t => t.txid === String(payment_id));
            if (transaction && transaction.status !== 'completed') {
                transaction.status = 'completed';
                user.balance = (user.balance || 0) + transaction.amount;
                await user.save();
                console.log(`Automated Success: Credited $${transaction.amount} USD to User ID: ${user._id}`);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("IPN Process Exception Error:", error.message);
        res.status(500).send('Internal Server Processing Failure');
    }
});

// ==========================================
// 4. GET HISTORY
// ==========================================
router.get("/history", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const sortedTransactions = user.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ success: true, history: sortedTransactions });
    } catch (error) {
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
