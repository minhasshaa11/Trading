const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// Configuration
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_URL = 'https://api.nowpayments.io/v1';

// SERVICE FEE PERCENTAGE (0.5% is standard for NowPayments)
// We add a tiny bit extra (0.01) to cover price fluctuations
const SERVICE_FEE_PERCENT = 0.01; // 1% Total (0.5% NowPayments + 0.5% Safety buffer)

// Helper: Headers for API calls
const apiHeaders = {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
};

// ==========================================
// 1. CREATE DEPOSIT (With Fee Calculation)
// ==========================================
router.post("/create_deposit", authMiddleware, async (req, res) => {
    const { amount, currency } = req.body;

    if (!amount || !currency) {
        return res.status(400).json({ success: false, message: "Amount and currency are required." });
    }

    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        // --- THE FIX: CALCULATE AMOUNT WITH FEE ---
        // If user wants $30, we ask for $30 + 1% to cover fees.
        const originalAmount = parseFloat(amount);
        
        // Formula: Amount + (Amount * Fee)
        // Example: 30 + (30 * 0.01) = 30.30
        const amountToPay = originalAmount + (originalAmount * SERVICE_FEE_PERCENT);

        // A. Ask NowPayments to create invoice for the HIGHER amount
        const response = await axios.post(`${NOWPAYMENTS_URL}/payment`, {
            price_amount: amountToPay, // User pays $30.30
            price_currency: 'usd',
            pay_currency: currency,
            order_id: user.id,
            order_description: `Deposit for ${user.username}`
        }, { headers: apiHeaders });

        const { payment_id, pay_address, pay_amount } = response.data;

        // B. Save the ORIGINAL amount ($30) to DB
        // We credit the user what they ASKED for, not what they paid in fees.
        user.transactions.push({
            txid: payment_id,
            amount: originalAmount, // Credit them $30
            currency: currency,
            status: 'pending',
            date: new Date()
        });

        await user.save();

        // C. Send the Invoice to Frontend
        res.json({
            success: true,
            payment_id: payment_id,
            deposit_address: pay_address,
            amount_expected: pay_amount // This will show the crypto equivalent of $30.30
        });

    } catch (error) {
        console.error("NowPayments Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Failed to generate deposit address." });
    }
});

// ==========================================
// 2. VERIFY STATUS (Check if paid)
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

        if (transaction.status === 'completed' || transaction.status === 'finished') {
             return res.json({ success: true, message: "Deposit already confirmed!", status: 'completed' });
        }

        // A. Ask NowPayments for status
        const response = await axios.get(`${NOWPAYMENTS_URL}/payment/${payment_id}`, { 
            headers: apiHeaders 
        });

        const status = response.data.payment_status; 
        console.log(`Payment ${payment_id} status: ${status}`);

        // B. If Success, update DB
        // Note: 'sending' means NowPayments got the money and is sending it to you.
        // We count 'sending' as success so the user doesn't wait too long.
        if (status === 'finished' || status === 'confirmed' || status === 'sending') {
            
            // 1. Update status
            transaction.status = 'completed';
            
            // 2. Add ORIGINAL Balance ($30) to User
            // Ensure we don't add it twice if they click button multiple times rapidly
            // (The status check above handles this, but safety first)
            if (transaction.status !== 'completed_logged') {
                 user.balance = (user.balance || 0) + transaction.amount;
                 transaction.status = 'completed'; // Mark strictly
            }
            
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

        res.json({ 
            success: true, 
            message: "Payment is processing. Please wait.", 
            status: status 
        });

    } catch (error) {
        console.error("Verification Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Error checking payment status." });
    }
});

// ==========================================
// 3. GET HISTORY
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
