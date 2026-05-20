'use strict';

/**
 * Send a successful JSON response.
 *
 * @param {import('express').Response} res
 * @param {number} statusCode   - HTTP status (default 200).
 * @param {object} payload      - Fields merged into `{ success: true, ...payload }`.
 *
 * @example
 *   return sendSuccess(res, 200, { data: user });
 *   return sendSuccess(res, 201, { message: 'Created', data: record });
 *   return sendSuccess(res, 200, { count: items.length, data: items });
 */
const sendSuccess = (res, statusCode = 200, payload = {}) =>
    res.status(statusCode).json({ success: true, ...payload });

/**
 * Send an error JSON response.
 *
 * @param {import('express').Response} res
 * @param {number} statusCode  - HTTP status (4xx / 5xx).
 * @param {string} message     - Human-readable error message.
 */
const sendError = (res, statusCode, message) =>
    res.status(statusCode).json({ success: false, message });

/**
 * Inline admin guard for controller handlers that need it.
 * Returns `false` (and immediately sends a 403) when the caller is not admin.
 * Returns `true` when the caller is an admin so execution continues.
 *
 * Use this inside controller bodies where the route is shared with other roles
 * and you want a guard at the action level, not the route level.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {string} [message]
 * @returns {boolean}
 *
 * @example
 *   if (!requireAdminGuard(req, res)) return;
 */
const requireAdminGuard = (req, res, message = 'Forbidden: admin access required') => {
    if (!req.user || req.user.role !== 'admin') {
        sendError(res, 403, message);
        return false;
    }
    return true;
};

module.exports = { sendSuccess, sendError, requireAdminGuard };
