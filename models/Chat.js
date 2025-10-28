// models/Chat.js

const mongoose = require('mongoose');

// --- 1. Message Schema ---
const MessageSchema = new mongoose.Schema({
    sender: {
        type: String, // 'user' or 'admin'
        required: true,
    },
    content: {
        type: String,
        required: true,
    },
    timestamp: {
        type: Date,
        default: Date.now,
    }
}, { _id: false }); // We don't need a separate ID for sub-documents

// --- 2. Chat Thread Schema ---
const ChatThreadSchema = new mongoose.Schema({
    // Link the thread to the user who created it
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true // A user should only have one active support thread
    },
    // The current status of the thread
    status: {
        type: String,
        enum: ['open', 'pending_admin_reply', 'closed'],
        default: 'open' // 'open' for new chats, 'pending_admin_reply' after user sends a message
    },
    // The history of all messages
    messages: [MessageSchema],
    
    // Quick reference fields for admin dashboard
    lastUpdated: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });


module.exports = mongoose.model('ChatThread', ChatThreadSchema);
