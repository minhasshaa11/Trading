const express = require('express');
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

    // --- RULE 1: VALIDATION CHECKS ---
    if (!amount || isNaN(withdrawalAmount) || withdrawalAmount < MINIMUM_WITHDRAWAL) {
        return res.status(400).json({ success: false, message: `Minimum withdrawal amount is $${MINIMUM_WITHDRAWAL}.` });
    }
    // --- ADDED: Specific ERC-20 address validation for user safety ---
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid ERC-20 wallet address.' });
    }
    // --------------------------------------------------------

    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        
        // --- RULE 2: REFERRAL AND WITHDRAWAL COUNT (This rule is preserved as requested) ---
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

        // --- REMOVED: The entire trading volume and 50% tax logic has been deleted. ---
        
        // --- SIMPLIFIED: The process is now direct. ---
        user.balance -= withdrawalAmount;
        
        user.transactions.push({
            txid: `WITHDRAW-${Date.now()}`,
            type: 'withdrawal',
            amount: withdrawalAmount,
            address: address,
            status: 'pending_review', // Changed to a more descriptive status
            date: new Date(),
            tax: 0, // Tax is now always 0
            finalAmount: withdrawalAmount // Final amount is always the full amount
        });

        // --- INCREMENT THE WITHDRAWAL COUNTER (Preserved) ---
        user.withdrawalCount += 1;
        // ----------------------------------------

        await user.save();

        res.json({
            success: true,
            // --- SIMPLIFIED: The response message is now always the same. ---
            message: 'Withdrawal request submitted successfully. It will be reviewed by an admin.',
            newBalance: user.balance
        });

    } catch (error) {
        console.error('Withdrawal request error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// This history route is unchanged and remains correct.
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
