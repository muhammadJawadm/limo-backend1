'use strict';

/**
 * Wraps an async route handler so that any rejected promise or thrown error
 * is forwarded to Express's `next(err)` global error handler instead of
 * crashing the process or requiring a per-handler try/catch.
 *
 * @param {Function} fn - Async Express route handler (req, res, next) => Promise
 * @returns {Function}  - Express-compatible route handler
 *
 * @example
 *   exports.getUser = asyncHandler(async (req, res) => {
 *       const user = await prisma.user.findUnique(...);
 *       res.json({ success: true, data: user });
 *   });
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
