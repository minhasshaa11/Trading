// index.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const https = require("https");

const User = require("./models/User");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const depositRoutes = require("./routes/deposit");
const adminRoutes = require("./routes/admin");
const withdrawRoutes = require("./routes/withdraw");

// ------------------ APP + SERVER + IO ------------------
const app = express();
const server = http.createServer(app);

/* FIX 1: Restrict CORS to allowed origins */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : ["https://trading-app-2s4e.onrender.com"];

const io = socketIo(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"],
    },
    /* FIX 8: Connection limits */
    maxHttpBufferSize: 1e6, // 1MB max message size
    pingTimeout: 30000,
    pingInterval: 25000,
});

// ------------------ MIDDLEWARE ------------------
app.use(
    cors({
        origin: ALLOWED_ORIGINS,
    })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

/* FIX 2: Rate limiting */
const rateLimit = {};
function rateLimiter(windowMs, maxRequests) {
    return function (req, res, next) {
        var ip = req.ip || req.connection.remoteAddress;
        var key = ip + ":" + req.path;
        var now = Date.now();

        if (!rateLimit[key]) {
            rateLimit[key] = { count: 1, resetTime: now + windowMs };
            return next();
        }

        if (now > rateLimit[key].resetTime) {
            rateLimit[key] = { count: 1, resetTime: now + windowMs };
            return next();
        }

        rateLimit[key].count++;
        if (rateLimit[key].count > maxRequests) {
            return res
                .status(429)
                .json({ message: "Too many requests. Please try again later." });
        }
        next();
    };
}

/* Cleanup stale rate limit entries every 5 minutes */
setInterval(function () {
    var now = Date.now();
    var keys = Object.keys(rateLimit);
    for (var i = 0; i < keys.length; i++) {
        if (now > rateLimit[keys[i]].resetTime) {
            delete rateLimit[keys[i]];
        }
    }
}, 5 * 60 * 1000);

/* Apply rate limiting to API routes */
app.use("/api/", rateLimiter(60 * 1000, 60)); // 60 requests per minute
app.use("/api/auth", rateLimiter(60 * 1000, 10)); // Auth: 10 per minute
app.use("/api/deposit", rateLimiter(60 * 1000, 20)); // Deposit: 20 per minute
app.use("/api/withdraw", rateLimiter(60 * 1000, 10)); // Withdraw: 10 per minute

app.use(
    express.static(path.join(__dirname, "public"), {
        maxAge: "1h",
        etag: true,
    })
);

// ------------------ SECURITY HEADERS ------------------
app.use(function (req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
});

// ------------------ ROUTES ------------------
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/deposit", depositRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);

app.get("/health", function (req, res) {
    res.status(200).send("OK");
});

// ------------------ DASHBOARD DATA ------------------
async function getDashboardData(userId) {
    /* FIX 7: Validate userId format before querying */
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        var err = new Error("Invalid user ID.");
        err.code = "INVALID_ID";
        throw err;
    }

    var user = await User.findById(userId).select(
        "username firstName balance active_package package_expiry_date"
    );
    if (!user) {
        var err = new Error("User not found.");
        err.code = "USER_NOT_FOUND";
        throw err;
    }
    return {
        username: user.username || user.firstName || "User",
        balance: user.balance || 0,
        activePackage: user.active_package || null,
        packageExpiry: user.package_expiry_date || null,
    };
}

// ------------------ SOCKET.IO AUTH ------------------
/* FIX 8: Track connections per user */
var userConnections = {};

io.use(function (socket, next) {
    var token = socket.handshake.auth.token;
    if (!token)
        return next(new Error("Authentication Error: Token not provided."));
    try {
        var decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.decoded = decoded;

        /* FIX 8: Limit connections per user (max 5) */
        var userId = decoded.id;
        if (!userConnections[userId]) userConnections[userId] = 0;
        if (userConnections[userId] >= 5) {
            return next(
                new Error("Too many connections. Please close other sessions.")
            );
        }
        userConnections[userId]++;

        next();
    } catch (ex) {
        return next(new Error("Authentication Error: Invalid token."));
    }
});

// ------------------ SOCKET.IO EVENTS ------------------
/* FIX 8: Socket-level rate limiting */
function socketRateLimit(socket, event, windowMs, maxCalls) {
    var key = "_rl_" + event;
    if (!socket[key]) socket[key] = { count: 0, resetTime: Date.now() + windowMs };

    var now = Date.now();
    if (now > socket[key].resetTime) {
        socket[key] = { count: 1, resetTime: now + windowMs };
        return true;
    }

    socket[key].count++;
    return socket[key].count <= maxCalls;
}

io.on("connection", function (socket) {
    /* FIX 7: Minimal logging in production */
    if (process.env.NODE_ENV !== "production") {
        console.log("User connected:", socket.id);
    }

    socket.on("request_dashboard_data", async function () {
        /* FIX 8: Rate limit socket events (10 per minute) */
        if (!socketRateLimit(socket, "dashboard", 60000, 10)) {
            socket.emit("dashboard_data", {
                success: false,
                message: "Too many requests. Please wait.",
            });
            return;
        }

        try {
            var userId = socket.decoded.id;
            var dashboardData = await getDashboardData(userId);
            socket.emit("dashboard_data", {
                success: true,
                data: dashboardData,
            });
        } catch (error) {
            /* FIX 7: Don't log sensitive data in production */
            if (process.env.NODE_ENV !== "production") {
                console.error("Dashboard data error:", error.message);
            }
            if (
                error.code === "USER_NOT_FOUND" ||
                error.code === "INVALID_ID"
            ) {
                socket.emit("auth_error", {
                    message: "User not found. Please login again.",
                });
            } else {
                socket.emit("dashboard_data", {
                    success: false,
                    message: "Could not fetch dashboard data.",
                });
            }
        }
    });

    socket.on("disconnect", function () {
        /* FIX 8: Decrement connection count */
        var userId = socket.decoded && socket.decoded.id;
        if (userId && userConnections[userId]) {
            userConnections[userId]--;
            if (userConnections[userId] <= 0) delete userConnections[userId];
        }

        if (process.env.NODE_ENV !== "production") {
            console.log("User disconnected:", socket.id);
        }
    });
});

// ------------------ CATCH-ALL ------------------
/* FIX 4: Safe catch-all with path validation */
app.get("*", function (req, res) {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({ message: "API endpoint not found." });
    }

    /* Sanitize path - only allow alphanumeric, hyphens, dots, slashes */
    var safePath = req.path.replace(/[^a-zA-Z0-9\-_./]/g, "");
    if (safePath !== req.path || safePath.includes("..")) {
        return res.sendFile(path.join(__dirname, "public", "dashboard.html"));
    }

    var filePath = path.join(__dirname, "public", safePath);
    /* Ensure resolved path is within public directory */
    var publicDir = path.resolve(path.join(__dirname, "public"));
    var resolvedPath = path.resolve(filePath);

    if (!resolvedPath.startsWith(publicDir)) {
        return res.sendFile(path.join(__dirname, "public", "dashboard.html"));
    }

    res.sendFile(filePath, function (err) {
        if (err)
            res.sendFile(path.join(__dirname, "public", "dashboard.html"));
    });
});

// ------------------ DATABASE ------------------
/* FIX 5: Remove deprecated options for Mongoose 6+ */
mongoose.connect(process.env.MONGO_URI);

var db = mongoose.connection;
db.on("error", function (err) {
    console.error("MongoDB connection error:", err.message);
});
db.once("open", function () {
    console.log("Connected to MongoDB");
});

// ------------------ KEEP ALIVE ------------------
/* FIX 3: Use env variable for URL */
var RENDER_URL =
    process.env.RENDER_URL || "https://trading-app-2s4e.onrender.com";

setInterval(function () {
    https
        .get(RENDER_URL + "/health", function (res) {
            if (process.env.NODE_ENV !== "production") {
                console.log("Keep-alive ping:", res.statusCode);
            }
        })
        .on("error", function (err) {
            if (process.env.NODE_ENV !== "production") {
                console.log("Keep-alive ping failed:", err.message);
            }
        });
}, 14 * 60 * 1000);

// ------------------ GRACEFUL SHUTDOWN ------------------
/* FIX 6: Clean shutdown */
function gracefulShutdown(signal) {
    console.log(signal + " received. Shutting down gracefully...");

    server.close(function () {
        console.log("HTTP server closed.");
        io.close(function () {
            console.log("Socket.io closed.");
            mongoose.connection.close(false, function () {
                console.log("MongoDB connection closed.");
                process.exit(0);
            });
        });
    });

    /* Force shutdown after 10 seconds */
    setTimeout(function () {
        console.error("Forced shutdown after timeout.");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", function () {
    gracefulShutdown("SIGTERM");
});
process.on("SIGINT", function () {
    gracefulShutdown("SIGINT");
});

// ------------------ START SERVER ------------------
var PORT = process.env.PORT || 5000;
server.listen(PORT, function () {
    console.log("Server running on port " + PORT);
});
