Const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { ethers } = require("ethers");
const User = require('../models/User');

// --- THE FIX ---
// REMOVED: The old, local auth middleware is gone.
// ADDED: We are now importing the main auth middleware used by the rest of your app.
const authMiddleware = require('../middleware/auth');
// ---------------

// Get next available deposit index
async function getNextDepositIndex() {
    try {
        const lastUser = await User.findOne({ depositAddressIndex: { $exists: true } }).sort({ depositAddressIndex: -1 });
        return lastUser ? lastUser.depositAddressIndex + 1 : 0;
    } catch (error) {
        console.error('Error getting deposit index:', error);
        return 0;
    }
}

// Get or generate deposit address
// CORRECTED: Using 'authMiddleware' instead of the old 'auth'
router.get("/address", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.depositAddress) {
            return res.json({ success: true, address: user.depositAddress });
        }

        if (!process.env.SEED_PHRASE) {
            return res.status(500).json({ success: false, message: "Server configuration error." });
        }

        const userIndex = await getNextDepositIndex();
        let address;
        try {
            const masterNode = ethers.HDNodeWallet.fromPhrase(process.env.SEED_PHRASE);
            const childNode = masterNode.derivePath(`44'/60'/0'/0/${userIndex}`);
            address = childNode.address;
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to generate address." });
        }

        user.depositAddress = address;
        user.depositAddressIndex = userIndex;
        await user.save();
        res.json({ success: true, address: address });
    } catch (error) {
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

// MODIFIED: Handle TXID and Amount Submission for Verification
// CORRECTED: Using 'authMiddleware' instead of the old 'auth'
router.post("/verify", authMiddleware, async (req, res) => {
    const { txid, amount } = req.body;

    if (!txid || typeof txid !== 'string' || txid.length < 10) {
        return res.status(400).json({ success: false, message: "Invalid TXID provided." });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Invalid amount provided." });
    }
    
    try {
        const existingTx = await User.findOne({ 'transactions.txid': txid });
        if (existingTx) {
            return res.status(400).json({ success: false, message: "This transaction has already been submitted." });
        }

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });
        
        user.transactions.push({ txid: txid, amount: parseFloat(amount) });
        await user.save();
        
        console.log(`SAVED TXID "${txid}" for user ${user.username} with amount ${amount}.`);
        res.json({ success: true, message: "Deposit details submitted successfully." });
    } catch (error) {
        res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
});

// Get Deposit History
// CORRECTED: Using 'authMiddleware' instead of the old 'auth'
router.get("/history", authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        const sortedTransactions = user.transactions.sort((a, b) => b.date - a.date);
        res.json({ success: true, history: sortedTransactions });
    } catch (error) {
        console.error('Error fetching deposit history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
