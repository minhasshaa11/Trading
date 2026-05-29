// index.js (Refactored for Investment Packages Model)
// ------------------ DEPENDENCIES ------------------
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const jwt = require('jsonwebtoken');

// ------------------ MODELS & ROUTES ------------------
// FIX: Use './models/User' because index.js and models are in the same directory.
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
// The 'app.set' for marketData is no longer needed

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

// ----- SIMPLIFIED: Real-time functionality for the new dashboard -----

// A simpler function to get the data our new dashboard needs
async function getDashboardData(userId) {
    // Note: The fields active_package and package_expiry_date might not exist in your current User model
    // unless you have added them manually. Ensure your User model is up-to-date.
    const user = await User.findById(userId).select('username balance active_package package_expiry_date');
    if (!user) {
        throw new Error('User not found.');
    }
    return {
        username: user.username,
        balance: user.balance,
        activePackage: user.active_package,
        packageExpiry: user.package_expiry_date,
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

// Main Socket.IO connection handler (simplified)
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // When the dashboard connects, send it the user's data
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

// REMOVED: All Binance market data, candle generation, and price polling functions are gone.

// ------------------ DB + STARTUP ------------------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));

db.once("open", async () => {
  console.log("✅ Connected to MongoDB");
  // REMOVED: No longer need to initialize market data or the old trade module
});

// ------------------ CATCH-ALL / STATIC SERVE ------------------
// This part is useful for making sure your front-end pages load correctly.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'API endpoint not found.' });
  
  // Try to find the file in the public directory (e.g., login.html, dashboard.html)
  res.sendFile(path.join(__dirname, 'public', req.path), (err) => {
    // If a specific file is not found, default to sending the main dashboard page.
    if (err) {
      res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    }
  });
});

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server is running and listening on port ${PORT}`));
