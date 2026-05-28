const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const ChatThread = require('../models/Chat'); 
const authMiddleware = require('../middleware/auth');

// --- NEW UPDATED TIER DEFINITIONS (60 Days Expiry) ---
const TIERS = {
    "Silver": { minPrice: 30, maxPrice: 99, minROI: 1.67, maxROI: 4.17, durationDays: 60 },
    "Gold":   { minPrice: 100, maxPrice: 499, minROI: 2.00, maxROI: 4.50, durationDays: 60 },
    "VIP":    { minPrice: 500, maxPrice: 100000, minROI: 2.50, maxROI: 5.00, durationDays: 60 }
};

// Helper: Determine package tier name based on investment dollar amount
function getTierNameByAmount(amount) {
    if (amount >= 30 && amount < 100) return "Silver";
    if (amount >= 100 && amount < 500) return "Gold";
    if (amount >= 500) return "VIP";
    return null;
}

// GET api/user/info - Provides basic user info with current daily random metadata
router.get('/info', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        res.json({ success: true, user: user });
    } catch (error) {
        console.error("Error fetching user info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET api/user/referral-info - Provides the user's referral data
router.get('/referral-info', authMiddleware, async (req, res) => {
    try {
        const userId = new mongoose.Types.ObjectId(req.user.id);
        const user = await User.findById(userId).select('referralCode referralCommissions');
        if (!user) { return res.status(404).json({ success: false, message: 'User not found.' }); }
        
        const referralCount = await User.countDocuments({ referredBy: userId });
        
        res.json({
            success: true,
            referralCode: user.referralCode,
            referralCount: referralCount,
            totalCommissions: user.referralCommissions
        });
    } catch (error) {
        console.error("Error fetching referral info:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST api/user/purchase-package - Flexible Investment Amount Package Purchasing
router.post('/purchase-package', authMiddleware, async (req, res) => {
    const { amount } = req.body; // Expecting raw numeric amount (e.g., 30, 150, 600)
    const numericAmount = parseFloat(amount);

    if (!numericAmount || numericAmount < 30) {
        return res.status(400).json({ success: false, message: "Minimum investment amount is $30." });
    }

    const tierName = getTierNameByAmount(numericAmount);
    if (!tierName) {
        return res.status(400).json({ success: false, message: "Invalid tier classification for this amount." });
    }
    
    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: "User not found." }); }
        
        if (user.balance < numericAmount) {
            return res.status(400).json({ success: false, message: "Insufficient balance to activate this investment." });
        }

        const tierConfig = TIERS[tierName];

        // Deduct balance and update detailed model tracking variables
        user.balance -= numericAmount;
        user.active_package = tierName; 
        user.active_investment_amount = numericAmount; 
        
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + tierConfig.durationDays);
        user.package_expiry_date = expiryDate;
        
        // Setup default placeholder state for today's entry
        user.earnings_today = 0.00;
        user.percentage_today = "0.00%";

        await user.save();
        res.json({ 
            success: true, 
            message: `$${numericAmount} allocated into ${tierName} Tier successfully! Plan active for 60 days.`, 
            newBalance: user.balance 
        });

    } catch (error) {
        console.error("Purchase package error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST api/user/claim-earnings - Handles claiming dynamically generated daily earnings
router.post('/claim-earnings', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: "User not found." }); }
        if (!user.active_package) {
            return res.status(400).json({ success: false, message: "You do not have an active package tier." });
        }
        if (new Date() > user.package_expiry_date) {
            return res.status(400).json({ success: false, message: "Your investment package has expired." });
        }

        const now = new Date();
        const todayReset = new Date();
        todayReset.setUTCHours(0, 0, 0, 0); 

        if (user.last_claim_timestamp && user.last_claim_timestamp > todayReset) {
            return res.status(400).json({ success: false, message: "You have already claimed your random profit allocation for today." });
        }

        if (!user.earnings_today || user.earnings_today <= 0) {
            return res.status(400).json({ success: false, message: "Today's dynamic returns haven't updated yet. Please check back shortly." });
        }

        const profitToClaim = user.earnings_today;
        user.balance += profitToClaim;
        user.last_claim_timestamp = now;
        
        // Soft reset today's value so double accumulation cannot happen
        user.earnings_today = 0.00; 

        await user.save();
        res.json({ success: true, message: `Successfully claimed today's return of $${profitToClaim} USD!`, newBalance: user.balance });

    } catch (error) {
        console.error("Claim earnings error:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- NEW ROUTES FOR CUSTOMER SUPPORT CHAT (Unchanged) ---
router.get('/support/initialize-chat', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        let thread = await ChatThread.findOne({ userId });

        if (!thread) {
            thread = new ChatThread({ userId, status: 'open' });
            await thread.save();
            return res.json({ success: true, chatId: thread._id, messages: [], message: "New chat thread created." });
        }

        res.json({ 
            success: true, 
            chatId: thread._id, 
            messages: thread.messages,
            message: "Existing chat thread loaded."
        });
    } catch (err) {
        console.error('Error initializing user chat:', err.message);
        res.status(500).json({ success: false, message: 'Server error during chat initialization.' });
    }
});

router.post('/support/send-message', authMiddleware, async (req, res) => {
    const { chatId, content } = req.body;
    if (!content || content.trim() === "") {
        return res.status(400).json({ success: false, message: "Message content cannot be empty." });
    }
    
    try {
        const userId = req.user.id;
        const thread = await ChatThread.findOne({ _id: chatId, userId });

        if (!thread) {
            return res.status(404).json({ success: false, message: "Chat thread not found or access denied." });
        }

        const newMessage = {
            sender: 'user',
            content: content.trim(),
            timestamp: new Date()
        };
        
        thread.messages.push(newMessage);
        thread.status = 'pending_admin_reply'; 
        thread.lastUpdated = new Date();
        
        await thread.save();
        res.json({ success: true, message: "Message sent.", newMessage });
    } catch (err) {
        console.error('Error sending user message:', err.message);
        res.status(500).json({ success: false, message: 'Server error during message send.' });
    }
});

// --- ACCOUNT LOG SUMMARY METRICS ---
router.get('/account-summary', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: 'User not found' }); }
        
        const totalWithdrawals = user.transactions
            .filter(tx => tx.type === 'withdrawal' && tx.status === 'completed')
            .reduce((sum, tx) => sum + (tx.amount || 0), 0);
            
        const lifetimeProfit = (user.balance + totalWithdrawals) - user.totalDeposits;
        res.json({
            success: true,
            summary: {
                totalDeposits: user.totalDeposits,
                totalWithdrawals: totalWithdrawals,
                lifetimeProfit: lifetimeProfit
            }
        });
    } catch (err) {
        console.error('Error fetching account summary:', err.message);
        res.status(500).send('Server Error');
    }
});

router.get('/recent-activity', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) { return res.status(404).json({ success: false, message: 'User not found' }); }
        
        const recentActivities = user.transactions
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5)
            .map(tx => ({ date: tx.date, type: tx.type, amount: tx.amount, status: tx.status }));
            
        res.json({ success: true, activities: recentActivities });
    } catch (err) {
        console.error('Error fetching recent activity:', err.message);
        res.status(500).send('Server Error');
    }
});

router.get('/my-referrals', authMiddleware, async (req, res) => {
    try {
        const referrals = await User.find({ referredBy: req.user.id })
                                    .select('username firstName createdAt') 
                                    .sort({ createdAt: -1 });
        res.json({ success: true, referrals: referrals });
    } catch (error) {
        console.error("Error fetching referrals:", error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
