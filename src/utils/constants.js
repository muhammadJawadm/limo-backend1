'use strict';

// ─── OTP ─────────────────────────────────────────────────────────────────────

/** OTP validity window in milliseconds (5 minutes). */
const OTP_EXPIRY_MS = 300_000;

// ─── RIDE ────────────────────────────────────────────────────────────────────

const ALLOWED_RIDE_STATUSES = ['upcoming', 'confirmed', 'ongoing', 'completed', 'cancelled'];

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

const ALLOWED_NOTIFICATION_ROLES = ['driver', 'customer'];

// ─── DRIVER TRAINING ─────────────────────────────────────────────────────────

const TRAINING_DEFAULTS = [
    { moduleNumber: 1,  title: 'Who We Are' },
    { moduleNumber: 2,  title: 'The Chauffeur App' },
    { moduleNumber: 3,  title: 'Reviewing Rides and Waiting Time Policy' },
    { moduleNumber: 4,  title: 'Service Improvement Opportunities' },
    { moduleNumber: 5,  title: 'Chauffeur Values - Act with Integrity' },
    { moduleNumber: 6,  title: 'Chauffeur Values - Be Adaptable' },
    { moduleNumber: 7,  title: 'Chauffeur Values - Be Consistent' },
    { moduleNumber: 8,  title: 'Chauffeur Values - Be Discreet' },
    { moduleNumber: 9,  title: 'Chauffeur Values - Be Refined' },
    { moduleNumber: 10, title: 'Chauffeur Values - Be Reliable' },
    { moduleNumber: 11, title: 'Chauffeur Values - Be Punctual' },
    { moduleNumber: 12, title: 'Chauffeur Values - Be Respectful' },
    { moduleNumber: 13, title: 'Chauffeur Values - Be Vehicle Champions' },
    { moduleNumber: 14, title: 'Chauffeur Values - Go Above and Beyond' },
    { moduleNumber: 15, title: 'Chauffeur Values - Prioritize Safety' },
];

module.exports = {
    OTP_EXPIRY_MS,
    ALLOWED_RIDE_STATUSES,
    ALLOWED_NOTIFICATION_ROLES,
    TRAINING_DEFAULTS,
};
