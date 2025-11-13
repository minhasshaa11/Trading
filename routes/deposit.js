const express = require('express');
const router = express.Router();
const axios = require('axios'); // REQUIRED: npm install axios
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Configuration
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_URL = 'https://api.nowpayments.io/v1';

// Helper: Headers for API calls
const apiHeaders = {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
};

// ==========================================
// 1. CREATE DEPOSIT (Generates Unique Address)
// ==========================================
// Frontend sends: { "amount": 100, "currency": "usdttrc20" }
// "currency" options examples: 'eth', 'btc', 'usdttrc20', 'usdterc20', 'bnb'
router.post("/create_deposit", authMiddleware, async (req, res) => {
    const { amount, currency } = req.body;

    if (!amount || !currency) {
        return res.status(400).json({ success: false, message: "Amount and currency are required." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // A. Ask NowPayments to create a payment invoice
        const response = await axios.post(`${NOWPAYMENTS_URL}/payment`, {
            price_amount: amount,      // The Dollar amount user wants to deposit
            price_currency: 'usd',     // We calculate value based on USD
            pay_currency: currency,    // The crypto they are paying with (e.g., usdttrc20)
            order_id: user.id,         // Tracking tag
            order_description: `Deposit for ${user.username}`
        }, { headers: apiHeaders });

        const { payment_id, pay_address, pay_amount } = response.data;

        // B. Save this "Pending" transaction to your DB
        // We use the existing 'transactions' array. 
        // We map 'payment_id' to 'txid' so you don't have to change your DB Schema.
        user.transactions.push({
            txid: payment_id,         // Storing Payment ID here temporarily
            amount: parseFloat(amount),
            currency: currency,
            status: 'pending',        // You might need to add this field to your User model
            date: new Date()
        });

        await user.save();

        // C. Send the Address to the User
        res.json({
            success: true,
            payment_id: payment_id,    // User needs this to verify later
            deposit_address: pay_address,
            amount_expected: pay_amount // Exact crypto amount they must send
        });

    } catch (error) {
        console.error("NowPayments Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Failed to generate deposit address." });
    }
});

// ==========================================
// 2. VERIFY STATUS (Check if paid)
// ==========================================
// Frontend sends: { "payment_id": "123456..." }
router.post("/verify", authMiddleware, async (req, res) => {
    const { payment_id } = req.body;

    if (!payment_id) {
        return res.status(400).json({ success: false, message: "Payment ID is required." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // Find the transaction in your DB
        const transaction = user.transactions.find(t => t.txid === payment_id);
        
        if (!transaction) {
            return res.status(404).json({ success: false, message: "Transaction record not found." });
        }

        // Check if already completed
        if (transaction.status === 'completed' || transaction.status === 'finished') {
             return res.json({ success: true, message: "Deposit already confirmed!", status: 'completed' });
        }

        // A. Ask NowPayments for current status
        const response = await axios.get(`${NOWPAYMENTS_URL}/payment/${payment_id}`, { 
            headers: apiHeaders 
        });

        const status = response.data.payment_status; 
        // Possible statuses: 'waiting', 'confirming', 'confirmed', 'sending', 'finished', 'failed'

        console.log(`Payment ${payment_id} status: ${status}`);

        // B. If Success, update DB
        if (status === 'finished' || status === 'confirmed') {
            // 1. Update transaction status
            transaction.status = 'completed';
            
            // 2. Add Balance to User (Uncomment and adjust field name below)
            // user.walletBalance = (user.walletBalance || 0) + transaction.amount;
            
            await user.save();
            
            return res.json({ 
                success: true, 
                message: "Deposit Successful! Balance Updated.", 
                status: 'completed' 
            });
        } else if (status === 'failed' || status === 'expired') {
            transaction.status = 'failed';
            await user.save();
            return res.json({ success: false, message: "Payment failed or expired.", status: status });
        }

        // If still waiting
        res.json({ 
            success: true, 
            message: "Payment is still processing. Please wait.", 
            status: status 
        });

    } catch (error) {
        console.error("Verification Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Error checking payment status." });
    }
});

// ==========================================
// 3. GET HISTORY (Same as before)
// ==========================================
router.get("/history", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        const sortedTransactions = user.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ success: true, history: sortedTransactions });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
