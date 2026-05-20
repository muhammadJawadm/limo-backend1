'use strict';

// ─── PATTERNS ─────────────────────────────────────────────────────────────────

/** Basic email format regex — same pattern used across auth and booking flows. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── SUPPORT ──────────────────────────────────────────────────────────────────

/**
 * Validates a support-request payload.
 * @param {{ firstName, lastName, email, phone, description }} payload
 * @returns {string|null} Error message, or null if valid.
 */
const validateSupportRequest = (payload) => {
    if (!payload.firstName   || !payload.firstName.trim())   return 'firstName is required';
    if (!payload.lastName    || !payload.lastName.trim())    return 'lastName is required';
    if (!payload.email       || !payload.email.trim())       return 'email is required';
    if (!payload.phone       || !payload.phone.trim())       return 'phone is required';
    if (!payload.description || !payload.description.trim()) return 'description is required';
    return null;
};

// ─── BOOKING ──────────────────────────────────────────────────────────────────

/**
 * Validates that all required passenger fields are present.
 * Accepts both flat (`passengerFirstName`) and nested (`passengerDetails.firstName`) shapes.
 * @param {object} raw - Raw request body.
 * @returns {string|null} Error message, or null if valid.
 */
const validatePassengerDetails = (raw) => {
    const details   = raw.passengerDetails || {};
    const firstName = raw.passengerFirstName || details.firstName;
    const lastName  = raw.passengerLastName  || details.lastName;
    const email     = raw.passengerEmail     || details.email;
    const phone     = raw.passengerPhone     || details.phone;

    if (!firstName || !lastName || !email || !phone) {
        return 'passengerDetails.firstName, passengerDetails.lastName, passengerDetails.email, passengerDetails.phone are required';
    }
    return null;
};

/**
 * Validates that all required booker fields are present (guest bookings only).
 * @param {object} raw - Raw request body.
 * @returns {string|null} Error message, or null if valid.
 */
const validateBookerDetails = (raw) => {
    const details   = raw.bookerDetails || {};
    const firstName = raw.bookerFirstName || details.firstName;
    const lastName  = raw.bookerLastName  || details.lastName;
    const email     = raw.bookerEmail     || details.email;
    const phone     = raw.bookerPhone     || details.phone;

    if (!firstName || !lastName || !email || !phone) {
        return 'bookerDetails.firstName, bookerDetails.lastName, bookerDetails.email, bookerDetails.phone are required for guest booking';
    }
    return null;
};

module.exports = {
    EMAIL_REGEX,
    validateSupportRequest,
    validatePassengerDetails,
    validateBookerDetails,
};
