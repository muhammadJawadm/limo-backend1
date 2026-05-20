'use strict';

const jwt = require('jsonwebtoken');

/**
 * Single source of truth for the JWT secret.
 * Every module that needs to sign or verify tokens imports this constant
 * instead of re-reading process.env and duplicating the fallback string.
 */
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-env';

/**
 * Signs a new JWT for the given user ID.
 * @param {string} userId
 * @returns {string} Signed JWT valid for 7 days.
 */
const generateToken = (userId) =>
    jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws a JsonWebTokenError if the token is invalid or expired.
 * @param {string} token
 * @returns {object} Decoded JWT payload.
 */
const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

module.exports = { generateToken, verifyToken, JWT_SECRET };
