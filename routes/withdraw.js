Const express = require('express');
const router = express.Router();
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// --- DEFINE YOUR WITHDRAWAL RULES HERE ---
const MINIMUM_WITHDRAWAL = 10;
const WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL = 2;
// -----------------------------------------

router.post('/request', async (req, res) => {
    const { amount, address } = req.body;
    const withdrawalAmount = parseFloat(amount);

    // --- RULE 1: CHECK FOR VALID INPUT AND MINIMUM AMOUNT ---
    if (!amount || isNaN(withdrawalAmount) || withdrawalAmount < MINIMUM_WITHDRAWAL) {
        return res.status(400).json({ success: false, message: `Minimum withdrawal amount is $${MINIMUM_WITHDRAWAL}.` });
    }
    if (!address || typeof address !== 'string' || address.length < 26) {
        return res.status(400).json({ success: false, message: 'Please enter a valid withdrawal address.' });
    }
    // --------------------------------------------------------

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        // --- RULE 2: CHECK REFERRAL AND WITHDRAWAL COUNT ---
        if (user.withdrawalCount >= WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL && user.referralCount === 0) {
            return res.status(403).json({ 
                success: false, 
                message: `You must refer at least one person to make more than ${WITHDRAWALS_ALLOWED_WITHOUT_REFERRAL} withdrawals.` 
            });
        }
        // ---------------------------------------------------

        if (user.balance < withdrawalAmount) {
            return res.status(400).json({ success: false, message: 'Insufficient balance.' });
        }

        // --- TRADING VOLUME REQUIREMENT LOGIC (Unchanged) ---
        const volumeRequirement = user.totalDeposits * 1.10;
        let taxAmount = 0;
        let finalAmount = withdrawalAmount;
        let responseMessage = 'Withdrawal request submitted successfully. It will be processed shortly.';

        if (user.totalTradeVolume < volumeRequirement) {
            taxAmount = withdrawalAmount * 0.50;
            finalAmount = withdrawalAmount - taxAmount;
            responseMessage = `A 50% tax of $${taxAmount.toFixed(2)} was applied for not meeting the trading volume requirement. Your request has been submitted.`;
        }
        // --- END OF LOGIC ---

        user.balance -= withdrawalAmount;
        
        user.transactions.push({
            txid: `WITHDRAW-${Date.now()}`,
            type: 'withdrawal',
            amount: withdrawalAmount,
            address: address,
            status: 'pending_processing',
            date: new Date(),
            tax: taxAmount,
            finalAmount: finalAmount
        });

        // --- INCREMENT THE WITHDRAWAL COUNTER ---
        user.withdrawalCount += 1;
        // ----------------------------------------

        await user.save();

        res.json({
            success: true,
            message: responseMessage,
            newBalance: user.balance
        });

    } catch (error) {
        console.error('Withdrawal request error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

router.get('/history', async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const withdrawalHistory = user.transactions
            .filter(tx => tx.type === 'withdrawal')
            .sort((a, b) => b.date - a.date);

        res.json({ success: true, history: withdrawalHistory });
    } catch (error) {
        console.error('Error fetching withdrawal history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
