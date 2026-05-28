// index.js (Fully Refactored for Tiered Random Rewards & 60 Days Auto-Expiry)
// ------------------ DEPENDENCIES ------------------
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const jwt = require('jsonwebtoken');
const cron = require('node-cron'); // NEW: Added for automated background tasks

// ------------------ MODELS & ROUTES ------------------
const User = require("./models/User"); 

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);

// ------------------ AUTOMATED DYNAMIC REWARD ENGINE ------------------

// Helper: Calculate random percentage based on current tier limits
function generateRandomTierPercentage(tierName) {
    let min, max;
    if (tierName === "Silver") { min = 1.67; max = 4.17; }
    else if (tierName === "Gold") { min = 2.00; max = 4.50; }
    else if (tierName === "VIP") { min = 2.50; max = 5.00; }
    else { return 0; }

    const rand = Math.random() * (max - min) + min;
    return parseFloat(rand.toFixed(2));
}

// CRON JOB: Runs automatically every night at 00:00 (Midnight UTC)
cron.schedule('0 0 * * *', async () => {
    console.log("⏳ Running Midnight Automated Reward Engine & Expiry Processor...");
    try {
        const now = new Date();
        
        // 1. SYSTEM OPERATION A: Handle Expired Accounts
        const expiryResult = await User.updateMany(
            { active_package: { $ne: null }, package_expiry_date: { $lt: now } },
            { 
                $set: { 
                    active_package: null, 
                    active_investment_amount: 0, 
                    package_expiry_date: null,
                    earnings_today: 0.00,
                    percentage_today: "0.00%"
                } 
            }
        );
        if (expiryResult.modifiedCount > 0) {
            console.log(`🧹 Cleaned up ${expiryResult.modifiedCount} expired investment contracts.`);
        }

        // 2. SYSTEM OPERATION B: Loop through active accounts and generate dynamic numbers
        const activeUsers = await User.find({ active_package: { $ne: null }, package_expiry_date: { $gte: now } });
        
        for (let user of activeUsers) {
            const currentTier = user.active_package;
            const capital = user.active_investment_amount || 30; // fallback safety
            
            const selectedPercentage = generateRandomTierPercentage(currentTier);
            const computedEarnings = capital * (selectedPercentage / 100);

            user.earnings_today = parseFloat(computedEarnings.toFixed(2));
            user.percentage_today = `${selectedPercentage}%`;
            
            await user.save();
        }
        
        console.log(`🎯 Successfully distributed random daily rewards to ${activeUsers.length} investors.`);
        
        // Push update notification directly to active sockets to instantly refresh screens
        io.emit('global_market_payout_refresh', { updated: true });

    } catch (error) {
        console.error("CRITICAL EXCEPTION IN CRON JOB ENGINE:", error.message);
    }
});

// ----- REAL-TIME SOCKET DATA SYNC ENGINE -----

// Upgraded to fetch the new tiered variable fields
async function getDashboardData(userId) {
    const user = await User.findById(userId).select(
        'username balance active_package active_investment_amount package_expiry_date earnings_today percentage_today'
    );
    if (!user) {
        throw new Error('User not found.');
    }
    return {
        username: user.username,
        balance: user.balance,
        activePackage: user.active_package,
        investmentAmount: user.active_investment_amount,
        packageExpiry: user.package_expiry_date,
        earningsToday: user.earnings_today,
        percentageToday: user.percentage_today
    };
}

// Socket.IO Authentication Middleware (unchanged)
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error("Authentication Error: Token not provided."));
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded; 
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

// Main Socket.IO connection handler
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Standard client data request logic
    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            const dashboardData = await getDashboardData(userId);
            socket.emit('dashboard_data', { success: true, data: dashboardData });
        } catch (error) {
            socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", async () => {
  console.log("✅ Connected to MongoDB");
});

// ------------------ CATCH-ALL / STATIC SERVE ------------------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
  
  res.sendFile(path.join(__dirname, 'public', req.path), (err) => {
    if (err) {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    }
  });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server is running and listening on port ${PORT}`));
