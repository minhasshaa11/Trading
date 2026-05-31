const mongoose = require("mongoose");

/* FIX 5: _id enabled for individual message operations */
/* FIX 1: maxlength on content */
/* FIX 4: sender enum validation */
/* FIX 6: content minlength */
var MessageSchema = new mongoose.Schema({
    sender: {
        type: String,
        required: true,
        enum: ["user", "admin"],
    },
    content: {
        type: String,
        required: true,
        minlength: [1, "Message cannot be empty"],
        maxlength: [2000, "Message too long"],
    },
    timestamp: {
        type: Date,
        default: Date.now,
    },
});

var ChatThreadSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },
        status: {
            type: String,
            enum: ["open", "pending_admin_reply", "closed"],
            default: "open",
            /* FIX 2: Index for admin queries */
            index: true,
        },
        /* FIX 1: Limit messages array using validate */
        messages: {
            type: [MessageSchema],
            validate: [
                function (val) {
                    return val.length <= 500;
                },
                "Chat history limit reached (500 messages). Please start a new thread.",
            ],
        },
        lastUpdated: {
            type: Date,
            default: Date.now,
            /* FIX 3: Index for admin sorting */
            index: true,
        },
    },
    { timestamps: true }
);

/* Compound index for admin dashboard: pending chats sorted by latest */
ChatThreadSchema.index({ status: 1, lastUpdated: -1 });

module.exports = mongoose.model("ChatThread", ChatThreadSchema);
