'use strict';

const { verifyToken } = require('../utils/jwt');
const { prisma } = require('../config/db');

// ─── PROTECT ─────────────────────────────────────────────────────────────────

/**
 * Requires a valid Bearer token.
 * Attaches `{ id, role, isVerified }` to `req.user` on success.
 */
const protect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'No token provided. Authorization denied.',
            });
        }

        const token   = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        const userId  = decoded.userId || decoded.id;

        // Fetch only the fields we need — never expose password
        const user = await prisma.user.findUnique({
            where:  { id: userId },
            select: { id: true, role: true, isVerified: true },
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'User not found. Token is invalid.',
            });
        }

        req.user = {
            id:         user.id,
            role:       user.role,
            isVerified: user.isVerified,
        };

        return next();
    } catch {
        return res.status(401).json({
            success: false,
            message: 'Token is invalid or expired.',
        });
    }
};

// ─── PROTECT OPTIONAL ────────────────────────────────────────────────────────

/**
 * Like `protect` but passes through unauthenticated requests instead of
 * rejecting them. Useful for routes that serve both guests and logged-in users.
 */
const protectOptional = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return next();
        }

        const token   = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        const userId  = decoded.userId || decoded.id;

        const user = await prisma.user.findUnique({
            where:  { id: userId },
            select: { id: true, role: true, isVerified: true },
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'User not found. Token is invalid.',
            });
        }

        req.user = {
            id:         user.id,
            role:       user.role,
            isVerified: user.isVerified,
        };

        return next();
    } catch {
        return res.status(401).json({
            success: false,
            message: 'Token is invalid or expired.',
        });
    }
};

// ─── REQUIRE ADMIN ───────────────────────────────────────────────────────────

/**
 * Express middleware that rejects non-admin callers with 403.
 * Must be used after `protect`.
 */
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
            success: false,
            message: 'Forbidden: admin access required',
        });
    }
    return next();
};

module.exports = { protect, protectOptional, requireAdmin };
