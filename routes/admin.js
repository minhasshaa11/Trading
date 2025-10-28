const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ChatThread = require('../models/Chat'); // <--- NEW REQUIREMENT

// Admin security middleware (unchanged)
const adminAuth = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    // IMPORTANT: Make sure the ADMIN_KEY is set in your .env file
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Forbidden: Invalid Admin Key" });
    }
    next();
};

router.use(adminAuth);

// --- NEW ROUTES FOR SUPPORT CHAT ---

// GET api/admin/support/tickets - Get a list of open and pending threads
router.get('/support/tickets', async (req, res) => {
    try {
        // Fetch threads that are not explicitly marked as 'closed'
        const tickets = await ChatThread.find({ status: { $ne: 'closed' } })
            .populate('userId', 'username firstName') // Populate user info for display
            .sort({ lastUpdated: -1 }) // Sort by most recent activity

        // Map data to include the last message content for quick view
        const formattedTickets = tickets.map(ticket => ({
            _id: ticket._id,
            user: {
                username: ticket.userId.username,
                firstName: ticket.userId.firstName,
                _id: ticket.userId._id
            },
            status: ticket.status,
            lastUpdated: ticket.lastUpdated,
            // Extract the last message if it exists
            lastMessage: ticket.messages.length > 0 ? ticket.messages[ticket.messages.length - 1] : null
        }));
        
        res.json({ success: true, tickets: formattedTickets });
    } catch (error) {
        console.error("Error fetching support tickets:", error);
        res.status(500).json({ success: false, message: "Server error fetching tickets." });
    }
});

// GET api/admin/support/messages/:chatId - Get all messages for a specific thread
router.get('/support/messages/:chatId', async (req, res) => {
    try {
        const { chatId } = req.params;
        
        const thread = await ChatThread.findById(chatId).select('messages userId');
        
        if (!thread) {
            return res.status(404).json({ success: false, message: "Chat thread not found." });
        }
        
        res.json({ success: true, messages: thread.messages });
    } catch (error) {
        console.error("Error fetching chat messages:", error);
        res.status(500).json({ success: false, message: "Server error fetching messages." });
    }
});

// POST api/admin/support/send-reply - Send a message from the admin
router.post('/support/send-reply', async (req, res) => {
    const { chatId, content } = req.body;

    if (!content || content.trim() === "") {
        return res.status(400).json({ success: false, message: "Reply content cannot be empty." });
    }
    
    try {
        const thread = await ChatThread.findById(chatId);

        if (!thread) {
            return res.status(404).json({ success: false, message: "Chat thread not found." });
        }

        const newMessage = {
            sender: 'admin',
            content: content.trim(),
            timestamp: new Date()
        };
        
        thread.messages.push(newMessage);
        thread.status = 'open'; // Mark back to 'open' after admin replies
        thread.lastUpdated = new Date();
        
        await thread.save();

        res.json({ success: true, message: "Reply sent.", newMessage });

    } catch (err) {
        console.error('Error sending admin reply:', err.message);
        res.status(500).json({ success: false, message: 'Server error during reply send.' });
    }
});

// --- ORIGINAL ROUTES CONTINUED ---

// GET all admin data (unchanged)
router.get('/data', async (req, res) => {
    try {
        const searchQuery = req.query.search ? { username: new RegExp(req.query.search, 'i') } : {};
        const users = await User.find(searchQuery).populate('referredBy', 'username').sort({ createdAt: -1 });
        
        res.json({
            success: true,
            users: users,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error fetching data." });
    }
});

// --- DEPOSIT & WITHDRAWAL MANAGEMENT ---
router.post('/approve-deposit', async (req, res) => {
    const { userId, txid } = req.body;
    if (!userId || !txid) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_review') {
            return res.status(400).json({ success: false, message: "Transaction not found or already processed." });
        }
        
        const depositAmount = parseFloat(transaction.amount);
        if (isNaN(depositAmount)) {
            return res.status(400).json({ success: false, message: "Invalid transaction amount stored." });
        }

        // --- Check if this is the user's first deposit ---
        const isFirstDeposit = (user.totalDeposits || 0) === 0;
        // ---------------------------------------------------

        transaction.status = 'completed';
        user.balance += depositAmount;
        user.totalDeposits += depositAmount;
        
        await user.save();

        // --- NEW: AUTOMATIC 7% REFERRAL COMMISSION LOGIC ---
        if (isFirstDeposit && user.referredBy) {
            try {
                const commissionRate = 0.07; // 7% commission
                const commissionAmount = depositAmount * commissionRate;

                // Find the referrer and award them the commission
                await User.findByIdAndUpdate(user.referredBy, {
                    $inc: { 
                        balance: commissionAmount,
                        referralCommissions: commissionAmount 
                    }
                });
                console.log(`AWARDED: $${commissionAmount.toFixed(2)} (7%) commission to referrer ID: ${user.referredBy} for a $${depositAmount.toFixed(2)} deposit.`);
            } catch (commissionError) {
                console.error("Failed to award referral commission:", commissionError);
                // We don't stop the main process, just log the error that it failed
            }
        }
        // -------------------------------------------------
        
        res.json({ success: true, message: `Deposit of $${depositAmount.toFixed(2)} approved. New balance: ${user.balance.toFixed(2)}` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during approval." });
    }
});

router.post('/reject-deposit', async (req, res) => {
    // This route is unchanged
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (transaction) {
            transaction.status = 'rejected';
            await user.save();
        }
        res.json({ success: true, message: "Deposit rejected." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during rejection." });
    }
});

router.post('/approve-withdrawal', async (req, res) => {
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_processing') {
            return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });
        }
        transaction.status = 'completed';
        await user.save();
        res.json({ success: true, message: "Withdrawal approved and marked as complete." });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during withdrawal approval." });
    }
});

router.post('/reject-withdrawal', async (req, res) => {
    const { userId, txid } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        const transaction = user.transactions.find(tx => tx.txid === txid);
        if (!transaction || transaction.status !== 'pending_processing') {
            return res.status(400).json({ success: false, message: "Withdrawal not found or already processed." });
        }
        transaction.status = 'rejected';
        user.balance += transaction.amount;
        await user.save();
        res.json({ success: true, message: `Withdrawal rejected. $${transaction.amount.toFixed(2)} has been refunded to the user.` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error during withdrawal rejection." });
    }
});

router.post('/credit-user', async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount || isNaN(parseFloat(amount))) {
        return res.status(400).json({ success: false, message: "Username and a valid amount are required." });
    }
    try {
        const user = await User.findOne({ username: username });
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        user.balance += parseFloat(amount);
        await user.save();
        res.json({ success: true, message: `Successfully updated ${user.username}'s balance to ${user.balance.toFixed(2)}` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error while crediting user." });
    }
});

router.post('/give-commission', async (req, res) => {
    const { username, amount } = req.body;
    if (!username || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Username and a valid positive amount are required." });
    }
    try {
        const commissionAmount = parseFloat(amount);
        const user = await User.findOneAndUpdate(
            { username: username }, 
            { $inc: { balance: commissionAmount, referralCommissions: commissionAmount } },
            { new: true }
        );
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        
        console.log(`ADMIN ACTION: Awarded $${commissionAmount.toFixed(2)} commission to ${user.username}.`);
        res.json({ success: true, message: `Successfully awarded $${commissionAmount.toFixed(2)} commission to ${user.username}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error while giving commission." });
    }
});

module.exports = router;
