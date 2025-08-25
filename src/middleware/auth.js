// middleware/auth.js
import jwt from "jsonwebtoken";

/**
 * Authentication middleware to protect routes using JWT.
 * Attaches decoded user info to req.user if token is valid.
 */
export const authMiddleware = (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
      return res.status(401).json({ error: "Access denied. No token provided." });
    }

    // Expected format: "Bearer <token>"
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ error: "Invalid authorization format" });
    }

    const token = parts[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // attach decoded payload to req.user

    next(); // proceed to next middleware or route
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired. Please log in again." });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token. Authentication failed." });
    }
    console.error("Auth middleware error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
