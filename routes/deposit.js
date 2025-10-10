const express = require('express');
const router = express.Router();
const { ethers } = require("ethers");
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

// This line applies authentication to all routes in this file
router.use(authMiddleware);

// This function for getting the next index is excellent and remains unchanged.
async function getNextDepositIndex() {
    try {
        const lastUser = await User.findOne({ depositAddressIndex: { $exists: true } }).sort({ depositAddressIndex: -1 });
        return lastUser ? lastUser.depositAddressIndex + 1 : 0;
    } catch (error) {
        console.error('Error getting deposit index:', error);
        return 0; // Fallback to 0 in case of error
    }
}

/**
 * @route   GET /api/deposit/address
 * @desc    Get or generate a unique deposit address for the user
 * @access  Private
 */
router.get("/address", async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        // If the user already has an address, return it immediately.
        if (user.depositAddress) {
            return res.json({ success: true, address: user.depositAddress });
        }

        // Check for the required seed phrase in environment variables.
        if (!process.env.SEED_PHRASE) {
            console.error("CRITICAL: SEED_PHRASE environment variable is not set!");
            return res.status(500).json({ success: false, message: "Server configuration error. Cannot generate address." });
        }

        const userIndex = await getNextDepositIndex();
        let address;
        try {
            // Your HD wallet generation logic is great. It remains unchanged.
            const masterNode = ethers.HDNodeWallet.fromPhrase(process.env.SEED_PHRASE);
            const childNode = masterNode.derivePath(`m/44'/60'/0'/0/${userIndex}`);
            address = childNode.address;
        } catch (error) {
            console.error("Ethers.js address generation failed:", error);
            return res.status(500).json({ success: false, message: "Failed to generate a new address." });
        }

        user.depositAddress = address;
        user.depositAddressIndex = userIndex;
        await user.save();
        res.json({ success: true, address: address });
    } catch (error) {
        console.error("Error in /address route:", error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

/**
 * @route   POST /api/deposit/verify
 * @desc    User submits a TXID for manual verification by an admin
 * @access  Private
 */
router.post("/verify", async (req, res) => {
    const { txid, amount } = req.body;

    if (!txid || typeof txid !== 'string' || txid.trim() === '') {
        return res.status(400).json({ success: false, message: "A valid Transaction ID (TXID) is required." });
    }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "A valid deposit amount is required." });
    }
    
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found." });

        // Prevent a user from submitting the same TXID twice
        const existingTx = user.transactions.find(t => t.txid.toLowerCase() === txid.toLowerCase());
        if (existingTx) {
            return res.status(400).json({ success: false, message: "This transaction ID has already been submitted." });
        }
        
        // Push a properly structured transaction object
        user.transactions.push({
            txid: txid,
            type: 'deposit',
            amount: parseFloat(amount),
            status: 'pending_review', // Status for admin to check
            date: new Date()
        });
        await user.save();
        
        res.json({ success: true, message: "Deposit submitted for verification. Your balance will be updated after admin review." });
    } catch (error) {
        console.error("Error in /verify route:", error);
        res.status(500).json({ success: false, message: "An internal server error occurred." });
    }
});

/**
 * @route   GET /api/deposit/history
 * @desc    Get the user's deposit transaction history
 * @access  Private
 */
router.get("/history", async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('transactions');
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        // Filter for deposits only and sort with the newest first
        const depositHistory = user.transactions
            .filter(tx => tx.type === 'deposit')
            .sort((a, b) => b.date - a.date);

        res.json({ success: true, history: depositHistory });
    } catch (error) {
        console.error('Error fetching deposit history:', error);
        res.status(500).json({ success: false, message: "Internal server error." });
    }
});

module.exports = router;
