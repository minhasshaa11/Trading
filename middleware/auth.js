const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
    var token = req.header("x-auth-token");

    if (!token) {
        /* FIX 1: Consistent response format */
        return res.status(401).json({
            success: false,
            message: "No token, authorization denied.",
            authError: true,
        });
    }

    /* FIX 4: Basic token format check (JWT has 3 parts separated by dots) */
    if (token.split(".").length !== 3) {
        return res.status(401).json({
            success: false,
            message: "Invalid token format.",
            authError: true,
        });
    }

    /* FIX 2: Check JWT_SECRET exists */
    if (!process.env.JWT_SECRET) {
        console.error("FATAL: JWT_SECRET is not set!");
        return res.status(500).json({
            success: false,
            message: "Server configuration error.",
        });
    }

    try {
        var decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        /* FIX 3: Differentiate expired vs invalid token */
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({
                success: false,
                message: "Token expired. Please login again.",
                authError: true,
                expired: true,
            });
        }

        return res.status(401).json({
            success: false,
            message: "Invalid token.",
            authError: true,
        });
    }
};
