'use strict';

/**
 * Operational (expected) HTTP error.
 * Throw this when you want a specific status code to reach the global error handler.
 *
 * @example
 *   throw new AppError('Booking not found', 404);
 */
class AppError extends Error {
    /**
     * @param {string} message  - Human-readable message.
     * @param {number} statusCode - HTTP status code (4xx / 5xx).
     */
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        /** Marks this as a known, handled error (not a programming bug). */
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;
