// index.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const jwt = require('jsonwebtoken');
const https = require('https');

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
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// ------------------ MIDDLEWARE ------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// FIX: Static files cache karo - pages fast load honge
app.use(express.static(path.join(__dirname, "public"), {
    maxAge: '1h',
    etag: true
}));

// ------------------ ROUTES ------------------
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);

// Health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// ------------------ DASHBOARD DATA ------------------
async function getDashboardData(userId) {
    const user = await User.findById(userId).select('username firstName balance active_package package_expiry_date');
    if (!user) {
        var err = new Error('User not found.');
        err.code = 'USER_NOT_FOUND';
        throw err;
    }
    return {
        // FIX: username null ho to firstName use karo
        username: user.username || user.firstName || 'User',
        balance: user.balance || 0,
        activePackage: user.active_package || null,
        packageExpiry: user.package_expiry_date || null,
    };
}

// ------------------ SOCKET.IO AUTH ------------------
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication Error: Token not provided."));
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;
        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

// ------------------ SOCKET.IO EVENTS ------------------
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('request_dashboard_data', async () => {
        try {
            const userId = socket.decoded.id;
            console.log(`Fetching dashboard data for user: ${userId}`);
            const dashboardData = await getDashboardData(userId);
            console.log(`Dashboard data fetched:`, dashboardData);
            socket.emit('dashboard_data', { success: true, data: dashboardData });
        } catch (error) {
            console.error('Dashboard data error:', error.message, error.stack);
            if (error.code === 'USER_NOT_FOUND') {
                socket.emit('auth_error', { message: 'User not found. Please login again.' });
            } else {
                socket.emit('dashboard_data', { success: false, message: 'Could not fetch dashboard data.' });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

// ------------------ CATCH-ALL ------------------
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ message: 'API endpoint not found.' });
    }
    res.sendFile(path.join(__dirname, 'public', req.path), (err) => {
        if (err) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

// ------------------ DATABASE ------------------
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});
const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => console.log("✅ Connected to MongoDB"));

// ------------------ KEEP ALIVE ------------------
// FIX: Server ko sleep hone se bachao - har 14 minute mein ping
const RENDER_URL = 'https://trading-app-2s4e.onrender.com';
setInterval(() => {
    https.get(`${RENDER_URL}/health`, (res) => {
        console.log(`Keep-alive ping: ${res.statusCode}`);
    }).on('error', (err) => {
        console.log('Keep-alive ping failed:', err.message);
    });
}, 14 * 60 * 1000);

// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
