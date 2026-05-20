'use strict';

const { prisma }       = require('../config/db');
const { buildRideFilter } = require('../utils/rideFilters');
const { transferDriverPayoutForBooking } = require('./paymentController');
const bcrypt           = require('bcrypt');
const { generateToken } = require('../utils/jwt');
const asyncHandler     = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { EMAIL_REGEX, validatePassengerDetails, validateBookerDetails } = require('../utils/validators');
const { calculateDistance } = require('../utils/googleMaps');
const { calculateTotalFare, calculateFareBreakdown, calculateToll } = require('../utils/fareCalculation');
// Child seat rates (USD) — adjust as needed or move to env/config
const CHILD_SEAT_RATES = {
    infant: 15, // per infant seat
    toddler: 10, // per toddler seat
    booster: 8, // per booster seat
};

// ─── PURE HELPERS ─────────────────────────────────────────────────────────────

const sanitizeBookingInput = (payload, options = {}) => {
    const data = { ...payload };
    if (data.type === 'ptop') delete data.hours;
    delete data.userId;
    if (!options.allowGuest) delete data.isGuest;
    delete data.paymentStatus;
    delete data.paymentIntentId;
    delete data.assignedDriverId;
    delete data.totalAmount;
    return data;
};

const generateConfNumber = () => {
    const timePart   = Date.now().toString().slice(-6);
    const randomPart = Math.floor(100 + Math.random() * 900).toString();
    return `CNF-${timePart}${randomPart}`;
};

const normalizeStopLocations = (payload) => {
    const stopLocations = payload.stopLocations || payload.stopLocation || [];
    delete payload.stopLocations;
    delete payload.stopLocation;
    return Array.isArray(stopLocations) ? stopLocations : [stopLocations];
};

const normalizeBookingDate = (value) => {
    if (value === undefined || value === null || value === '') return value;
    return value instanceof Date ? value : new Date(value);
};

const ensureCanEditBooking = (req, booking) => {
    if (req.user) {
        const isOwner          = booking.userId          === req.user.id;
        const isAssignedDriver = booking.assignedDriverId === req.user.id;
        if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
            return { allowed: false, status: 403, message: 'Forbidden: Not authorized to update this booking' };
        }
        return { allowed: true };
    }
    if (!booking.isGuest) {
        return { allowed: false, status: 401, message: 'Authorization required for this booking' };
    }
    return { allowed: true };
};

const validateStep1Payload = (raw) => {
    if (!raw.type)             return 'type is required';
    if (!raw.pickupLocation)   return 'pickupLocation is required';
    if (!raw.dropoffLocation)  return 'dropoffLocation is required';
    if (!raw.date)             return 'date is required';
    if (!raw.time)             return 'time is required';
    if (raw.type === 'hourly' && (raw.hours === undefined || raw.hours === null)) {
        return 'hours is required for hourly bookings';
    }
    return null;
};

const assertStep1Complete = (booking) => {
    if (!booking.type || !booking.pickupLocation || !booking.dropoffLocation || !booking.date || !booking.time) {
        return 'Step 1 is incomplete';
    }
    if (booking.type === 'hourly' && (booking.hours === null || booking.hours === undefined)) {
        return 'Step 1 is incomplete: hours missing';
    }
    return null;
};

const assertStep2Complete = (booking) => {
    const step1Error = assertStep1Complete(booking);
    if (step1Error) return step1Error;
    if (!booking.vehicleCategoryId) return 'Step 2 is incomplete: vehicleCategoryId missing';
    return null;
};

const assertStep4Complete = (booking) => {
    if (!booking.passengerFirstName || !booking.passengerLastName || !booking.passengerEmail || !booking.passengerPhone) {
        return 'Step 4 is incomplete: passenger details missing';
    }
    if (booking.isGuest) {
        if (!booking.bookerFirstName || !booking.bookerLastName || !booking.bookerEmail || !booking.bookerPhone) {
            return 'Step 4 is incomplete: booker details missing';
        }
    }
    return null;
};

const getGuestAccountPayload = (raw) => {
    const accountDetails = raw.accountDetails || {};
    const firstName  = accountDetails.firstName || raw.accountFirstName || raw.bookerDetails?.firstName || raw.bookerFirstName;
    const lastName   = accountDetails.lastName  || raw.accountLastName  || raw.bookerDetails?.lastName  || raw.bookerLastName;
    const email      = accountDetails.email     || raw.accountEmail     || raw.bookerDetails?.email     || raw.bookerEmail;
    const phone      = accountDetails.phone     || raw.accountPhone     || raw.bookerDetails?.phone     || raw.bookerPhone;
    const password   = accountDetails.password  || raw.accountPassword  || raw.password;
    const location   = accountDetails.location  || raw.accountLocation  || raw.location || raw.pickupLocation;
    const createAccount = raw.createAccount === true || Boolean(password);
    return { createAccount, firstName, lastName, email, phone, password, location };
};

const createBookingUserIfRequested = async (raw) => {
    const accountPayload = getGuestAccountPayload(raw);
    if (!accountPayload.createAccount) {
        return { userId: undefined, user: null, token: null, accountCreated: false };
    }
    if (!accountPayload.firstName || !accountPayload.lastName || !accountPayload.email || !accountPayload.phone) {
        return { error: 'firstName, lastName, email, and phone are required when createAccount is true' };
    }
    if (!EMAIL_REGEX.test(accountPayload.email.trim())) {
        return { error: 'Invalid email format for account creation' };
    }
    if (!accountPayload.password || accountPayload.password.length < 8) {
        return { error: 'password must be at least 8 characters when createAccount is true' };
    }
    const normalizedEmail = accountPayload.email.trim().toLowerCase();
    const normalizedPhone = accountPayload.phone.trim();
    const existingUser = await prisma.user.findFirst({
        where: { OR: [{ email: normalizedEmail }, { phone: normalizedPhone }] },
    });
    if (existingUser) {
        return { userId: existingUser.id, user: existingUser, token: null, accountCreated: false, linkedExistingAccount: true };
    }
    const hashedPassword = await bcrypt.hash(accountPayload.password, 10);
    const user = await prisma.user.create({
        data: {
            firstName: accountPayload.firstName.trim(),
            lastName:  accountPayload.lastName.trim(),
            email:     normalizedEmail,
            phone:     normalizedPhone,
            password:  hashedPassword,
            location:  accountPayload.location ? accountPayload.location.trim() : accountPayload.location,
            role:      'customer',
        },
    });
    return { userId: user.id, user, token: generateToken(user.id), accountCreated: true, linkedExistingAccount: false };
};

const buildBookingData = (payload) => {
    const data = {};
    const directFields = [
        'type','pickupLocation','dropoffLocation','date','time','hours','vehicleCategoryId',
        'assignedDriverId','confNumber','rideStatus','totalAmount','flightNumber','noOfPassengers',
        'luggage','childSeatRequired','isGuest','userId','specialInstructions','paymentStatus',
        'paymentIntentId','paymentMethodId','cardBrand','chargeId','receiptUrl','paymentConfirmedAt','platformFee','driverAmount','tripPrice','tollCharges','childSeatsFee','otherFees','childSeatInfant',
        'childSeatToddler','childSeatBooster','passengerFirstName','passengerLastName',
        'passengerEmail','passengerPhone','bookerFirstName','bookerLastName','bookerEmail','bookerPhone',
    ];
    for (const field of directFields) {
        if (payload[field] !== undefined) data[field] = payload[field];
    }
    if (payload.date !== undefined) {
        data.date = normalizeBookingDate(payload.date);
    }
    if (payload.childSeats) {
        if (payload.childSeats.infant   !== undefined) data.childSeatInfant   = payload.childSeats.infant;
        if (payload.childSeats.toddler  !== undefined) data.childSeatToddler  = payload.childSeats.toddler;
        if (payload.childSeats.booster  !== undefined) data.childSeatBooster  = payload.childSeats.booster;
    }
    if (payload.passengerDetails) {
        if (payload.passengerDetails.firstName !== undefined) data.passengerFirstName = payload.passengerDetails.firstName;
        if (payload.passengerDetails.lastName  !== undefined) data.passengerLastName  = payload.passengerDetails.lastName;
        if (payload.passengerDetails.email     !== undefined) data.passengerEmail     = payload.passengerDetails.email;
        if (payload.passengerDetails.phone     !== undefined) data.passengerPhone     = payload.passengerDetails.phone;
    }
    if (payload.bookerDetails) {
        if (payload.bookerDetails.firstName !== undefined) data.bookerFirstName = payload.bookerDetails.firstName;
        if (payload.bookerDetails.lastName  !== undefined) data.bookerLastName  = payload.bookerDetails.lastName;
        if (payload.bookerDetails.email     !== undefined) data.bookerEmail     = payload.bookerDetails.email;
        if (payload.bookerDetails.phone     !== undefined) data.bookerPhone     = payload.bookerDetails.phone;
    }
    if (payload.chargesAndFees) {
        if (payload.chargesAndFees.tripPrice    !== undefined) data.tripPrice    = payload.chargesAndFees.tripPrice;
        if (payload.chargesAndFees.tollCharges  !== undefined) data.tollCharges  = payload.chargesAndFees.tollCharges;
        if (payload.chargesAndFees.childSeatsFee !== undefined) data.childSeatsFee = payload.chargesAndFees.childSeatsFee;
        if (payload.chargesAndFees.otherFees    !== undefined) data.otherFees    = payload.chargesAndFees.otherFees;
    }
    return data;
};

const calculateBookingPricing = async (raw, category, stopLocations, logLabel) => {
    let distanceMiles = 0;
    let fareBreakdown = null;

    try {
        if (raw.pickupLocation && raw.dropoffLocation) {
            const distanceResult = await calculateDistance(raw.pickupLocation, raw.dropoffLocation, stopLocations);
            distanceMiles = distanceResult.distanceMiles;

            const tripFare = calculateTotalFare(
                raw.type,
                distanceMiles,
                raw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            const tollCharges = calculateToll(distanceMiles);

            fareBreakdown = calculateFareBreakdown(
                raw.type,
                distanceMiles,
                raw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            return {
                distanceMiles,
                fareBreakdown,
                tripPrice: tripFare,
                tollCharges,
            };
        }

        return {
            distanceMiles: 0,
            fareBreakdown: null,
            tripPrice: category.baseFare,
            tollCharges: 0,
        };
    } catch (error) {
        console.error(`Distance calculation error in ${logLabel}:`, error);
        return {
            distanceMiles: 0,
            fareBreakdown: null,
            tripPrice: category.baseFare,
            tollCharges: 0,
        };
    }
};

const createBookingFromPayload = async (req, raw, options = {}) => {
    const stopLocations = raw.stopLocations || raw.stopLocation || [];
    delete raw.stopLocations;
    delete raw.stopLocation;

    const vehicleCategoryId = raw.vehicleCategory || raw.vehicleCategoryId;
    delete raw.vehicleCategory;

    if (!vehicleCategoryId) {
        return { error: 'vehicleCategory is required' };
    }

    const category = await prisma.vehicleCategory.findUnique({ where: { id: vehicleCategoryId } });
    if (!category) {
        return { error: 'Vehicle category not found' };
    }

    let accountResult = { userId: undefined, user: null, token: null, accountCreated: false, linkedExistingAccount: false };
    if (options.allowGuestFlow) {
        accountResult = req.user
            ? { userId: req.user.id, user: null, token: null, accountCreated: false, linkedExistingAccount: false }
            : await createBookingUserIfRequested(raw);
        if (accountResult.error) {
            return { error: accountResult.error };
        }
    } else {
        if (!req.user) {
            return { error: 'Authentication required for this booking endpoint' };
        }
        accountResult = { userId: req.user.id, user: null, token: null, accountCreated: false, linkedExistingAccount: false };
    }

    const data = buildBookingData(raw);
    data.userId            = accountResult.userId || undefined;
    data.isGuest           = options.allowGuestFlow ? !accountResult.userId : false;
    data.vehicleCategoryId = vehicleCategoryId;
    data.rideStatus        = data.rideStatus || 'upcoming';
    data.confNumber        = data.confNumber || generateConfNumber();

    const pricing = await calculateBookingPricing(raw, category, stopLocations, options.logLabel || 'createBookingFromPayload');
    data.distanceMiles = pricing.distanceMiles;
    data.tripPrice     = pricing.tripPrice;
    data.tollCharges   = pricing.tollCharges;
    data.childSeatsFee = data.childSeatsFee || 0;
    data.otherFees     = data.otherFees || 0;
    data.totalAmount   = parseFloat((data.tripPrice + data.tollCharges + data.childSeatsFee + data.otherFees).toFixed(2));

    const booking = await prisma.booking.create({
        data: { ...data, stopLocations: { create: stopLocations.map((loc) => ({ location: loc })) } },
        include: bookingInclude,
    });

    return { booking, pricing, accountResult };
};

const formatBooking = (booking) => {
    if (!booking) return null;
    return {
        ...booking,
        // Pricing (at root level)
        tripPrice: booking.tripPrice || 0,
        tollCharges: booking.tollCharges || 0,
        childSeatsFee: booking.childSeatsFee || 0,
        otherFees: booking.otherFees || 0,
        // Nested objects for convenience
        childSeats: {
            infant:  booking.childSeatInfant,
            toddler: booking.childSeatToddler,
            booster: booking.childSeatBooster,
        },
        passengerDetails: {
            firstName: booking.passengerFirstName,
            lastName:  booking.passengerLastName,
            email:     booking.passengerEmail,
            phone:     booking.passengerPhone,
        },
        bookerDetails: {
            firstName: booking.bookerFirstName,
            lastName:  booking.bookerLastName,
            email:     booking.bookerEmail,
            phone:     booking.bookerPhone,
        },
        // Stripe payment details at root
        paymentMethodId: booking.paymentMethodId || null,
        cardBrand: booking.cardBrand || null,
        chargeId: booking.chargeId || null,
        receiptUrl: booking.receiptUrl || null,
        paymentConfirmedAt: booking.paymentConfirmedAt || null,
        stopLocations: booking.stopLocations?.map((s) => s.location) || [],
    };
};

const bookingInclude = {
    vehicleCategory: true,
    stopLocations:   true,
    assignedDriver:  { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
    user:            { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
};

// ─── STEP 1: CREATE BOOKING ───────────────────────────────────────────────────

exports.createBookingStep1 = asyncHandler(async (req, res) => {
    const raw           = sanitizeBookingInput(req.body, { allowGuest: true });
    const stopLocations = normalizeStopLocations(raw);

    const step1Error = validateStep1Payload(raw);
    if (step1Error) return sendError(res, 400, step1Error);

    if (!req.user && !raw.isGuest) {
        return sendError(res, 400, 'isGuest must be true for unauthenticated step 1');
    }

    const data = buildBookingData(raw);
    data.userId     = req.user ? req.user.id : undefined;
    data.isGuest    = !req.user;
    data.rideStatus = data.rideStatus || 'upcoming';
    data.confNumber = data.confNumber || generateConfNumber();

    // Calculate distance if locations available (preview for frontend)
    let distanceMiles = 0;
    try {
        if (raw.pickupLocation && raw.dropoffLocation) {
            const distanceResult = await calculateDistance(raw.pickupLocation, raw.dropoffLocation, stopLocations);
            distanceMiles = distanceResult.distanceMiles;
            data.distanceMiles = distanceMiles;
        }
    } catch (error) {
        console.error('Distance calculation error in Step 1:', error);
        // Continue without distance if calculation fails
    }

    const booking = await prisma.booking.create({
        data: { ...data, stopLocations: { create: stopLocations.map((loc) => ({ location: loc })) } },
        include: bookingInclude,
    });

    return sendSuccess(res, 201, { data: formatBooking(booking), distanceMiles });
});

// ─── STEP 2: ADD VEHICLE CATEGORY & CALCULATE FARE ────────────────────────────

exports.updateBookingStep2 = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.booking.findUnique({ where: { id }, include: { stopLocations: true } });
    if (!existing) return sendError(res, 404, 'Booking not found');

    const auth = ensureCanEditBooking(req, existing);
    if (!auth.allowed) return sendError(res, auth.status, auth.message);

    const step1Error = assertStep1Complete(existing);
    if (step1Error) return sendError(res, 400, step1Error);

    const raw               = sanitizeBookingInput(req.body);
    const vehicleCategoryId = raw.vehicleCategory || raw.vehicleCategoryId;
    delete raw.vehicleCategory;

    if (!vehicleCategoryId)                               return sendError(res, 400, 'vehicleCategoryId is required');
    if (raw.noOfPassengers === undefined || raw.noOfPassengers === null) return sendError(res, 400, 'noOfPassengers is required');
    if (raw.luggage        === undefined || raw.luggage        === null) return sendError(res, 400, 'luggage is required');

    const category = await prisma.vehicleCategory.findUnique({ where: { id: vehicleCategoryId } });
    if (!category) return sendError(res, 404, 'Vehicle category not found');

    // Calculate distance using Google Maps
    let distanceMiles = 0;
    let distanceError = null;
    let fareBreakdown = null;

    try {
        const stopLocations = existing.stopLocations ? existing.stopLocations.map((s) => s.location) : [];
        const distanceResult = await calculateDistance(existing.pickupLocation, existing.dropoffLocation, stopLocations);
        distanceMiles = distanceResult.distanceMiles;

        // Calculate fare based on booking type
        const tripFare = calculateTotalFare(
            existing.type,
            distanceMiles,
            existing.hours,
            category.baseFare,
            category.perMileRate30,
            category.perMileRate40,
            category.perHour
        );

        // Calculate toll charges (based on distance)
        const tollCharges = calculateToll(distanceMiles);

        fareBreakdown = calculateFareBreakdown(
            existing.type,
            distanceMiles,
            existing.hours,
            category.baseFare,
            category.perMileRate30,
            category.perMileRate40,
            category.perHour
        );

        const data = buildBookingData(raw);
        data.vehicleCategoryId = vehicleCategoryId;
        data.distanceMiles     = distanceMiles;
        data.tripPrice         = tripFare; // fare portion excluding child seats / toll / other fees
        data.tollCharges       = tollCharges;
        data.childSeatsFee     = existing.childSeatsFee || 0;
        data.otherFees         = existing.otherFees || 0;
        data.totalAmount       = parseFloat((tripFare + tollCharges + (data.childSeatsFee || 0) + (data.otherFees || 0)).toFixed(2));

        const booking = await prisma.booking.update({ where: { id }, data, include: bookingInclude });
        
        return sendSuccess(res, 200, {
            data: formatBooking(booking),
            fareBreakdown,
            distanceMiles,
        });
    } catch (error) {
        // If distance calculation fails, use base fare as fallback
        distanceError = error.message;
        console.error('Distance calculation error:', error);

        const data = buildBookingData(raw);
        data.vehicleCategoryId = vehicleCategoryId;
        data.tripPrice         = category.baseFare;
        data.tollCharges       = 0; // No toll calculated when distance fails
        data.childSeatsFee     = existing.childSeatsFee || 0;
        data.otherFees         = existing.otherFees || 0;
        data.totalAmount       = parseFloat((category.baseFare + (data.childSeatsFee || 0) + (data.otherFees || 0)).toFixed(2));

        const booking = await prisma.booking.update({ where: { id }, data, include: bookingInclude });
        
        return sendSuccess(res, 200, {
            data: formatBooking(booking),
            warning: `Distance calculation failed (${distanceError}). Using base fare. Distance value was not stored.`,
            distanceMiles: null,
            fareBreakdown: null,
        });
    }
});

// ─── STEP 3: ADD CHILD SEATS ──────────────────────────────────────────────────

exports.updateBookingStep3 = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return sendError(res, 404, 'Booking not found');

    const auth = ensureCanEditBooking(req, existing);
    if (!auth.allowed) return sendError(res, auth.status, auth.message);

    const step2Error = assertStep2Complete(existing);
    if (step2Error) return sendError(res, 400, step2Error);

    const raw       = sanitizeBookingInput(req.body);
    const childSeats = raw.childSeats || {};

    const hasChildSeatsData =
        raw.childSeatRequired !== undefined ||
        raw.childSeatInfant   !== undefined ||
        raw.childSeatToddler  !== undefined ||
        raw.childSeatBooster  !== undefined ||
        childSeats.infant   !== undefined   ||
        childSeats.toddler  !== undefined   ||
        childSeats.booster  !== undefined;

    if (!hasChildSeatsData) return sendError(res, 400, 'childSeats info is required');

    // Determine new counts (prefer explicit fields, then nested object, then keep existing)
    const infantCount  = (raw.childSeatInfant  !== undefined) ? raw.childSeatInfant  : (childSeats.infant  !== undefined ? childSeats.infant  : (existing.childSeatInfant  || 0));
    const toddlerCount = (raw.childSeatToddler !== undefined) ? raw.childSeatToddler : (childSeats.toddler !== undefined ? childSeats.toddler : (existing.childSeatToddler || 0));
    const boosterCount = (raw.childSeatBooster !== undefined) ? raw.childSeatBooster : (childSeats.booster !== undefined ? childSeats.booster : (existing.childSeatBooster || 0));

    // Calculate child seats fee
    const newChildSeatsFee = parseFloat((infantCount * CHILD_SEAT_RATES.infant + toddlerCount * CHILD_SEAT_RATES.toddler + boosterCount * CHILD_SEAT_RATES.booster).toFixed(2));
    const prevChildSeatsFee = existing.childSeatsFee || 0;

    // Determine trip price (fare portion) — prefer stored tripPrice, fallback to existing.totalAmount
    const tripPrice = existing.tripPrice || existing.totalAmount || 0;
    const tollCharges = existing.tollCharges || 0;

    // New total = tripPrice (fare) + toll - previous child seats fee + new child seats fee + otherFees
    const otherFees = existing.otherFees || 0;
    const newTotalAmount = parseFloat((tripPrice + tollCharges - prevChildSeatsFee + newChildSeatsFee + otherFees).toFixed(2));

    const payload = buildBookingData(raw);
    // Ensure child seat counts are set on booking
    payload.childSeatInfant  = infantCount;
    payload.childSeatToddler = toddlerCount;
    payload.childSeatBooster = boosterCount;
    payload.childSeatsFee    = newChildSeatsFee;
    payload.tripPrice        = tripPrice;
    payload.tollCharges      = tollCharges;
    payload.otherFees        = otherFees;
    payload.totalAmount      = newTotalAmount;

    const booking = await prisma.booking.update({ where: { id }, data: payload, include: bookingInclude });
    return sendSuccess(res, 200, { data: formatBooking(booking) });
});

// ─── STEP 4: ADD PASSENGER/BOOKER DETAILS ─────────────────────────────────────

exports.updateBookingStep4 = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return sendError(res, 404, 'Booking not found');

    const auth = ensureCanEditBooking(req, existing);
    if (!auth.allowed) return sendError(res, auth.status, auth.message);

    const step2Error = assertStep2Complete(existing);
    if (step2Error) return sendError(res, 400, step2Error);

    const raw = sanitizeBookingInput(req.body);

    const passengerError = validatePassengerDetails(raw);
    if (passengerError) return sendError(res, 400, passengerError);

    if (existing.isGuest) {
        const bookerError = validateBookerDetails(raw);
        if (bookerError) return sendError(res, 400, bookerError);
    }

    const booking = await prisma.booking.update({ where: { id }, data: buildBookingData(raw), include: bookingInclude });
    return sendSuccess(res, 200, { data: formatBooking(booking) });
});

// ─── STEP 5: COMPLETE BOOKING ────────────────────────────────────────────────

exports.updateBookingStep5 = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return sendError(res, 404, 'Booking not found');

    const auth = ensureCanEditBooking(req, existing);
    if (!auth.allowed) return sendError(res, auth.status, auth.message);

    const step2Error = assertStep2Complete(existing);
    if (step2Error) return sendError(res, 400, step2Error);

    const step4Error = assertStep4Complete(existing);
    if (step4Error) return sendError(res, 400, step4Error);

    const raw  = sanitizeBookingInput(req.body);
    const data = buildBookingData(raw);
    data.isComplete = true;

    const booking = await prisma.booking.update({ where: { id }, data, include: bookingInclude });
    return sendSuccess(res, 200, { data: formatBooking(booking) });
});

// ─── CREATE BOOKING (logged-in user) ──────────────────────────────────────────

exports.createBooking = asyncHandler(async (req, res) => {
    const raw = sanitizeBookingInput(req.body);
    const result = await createBookingFromPayload(req, raw, { allowGuestFlow: false, logLabel: 'createBooking' });
    if (result.error) return sendError(res, 400, result.error);

    return sendSuccess(res, 201, {
        data: formatBooking(result.booking),
        fareBreakdown: result.pricing.fareBreakdown,
        distanceMiles: result.pricing.distanceMiles,
    });
});

// ─── CREATE BOOKING (all-in-one) ─────────────────────────────────────────────

exports.createBookingAllInOne = asyncHandler(async (req, res) => {
    const raw = sanitizeBookingInput(req.body, { allowGuest: true });
    const result = await createBookingFromPayload(req, raw, { allowGuestFlow: true, logLabel: 'createBookingAllInOne' });
    if (result.error) return sendError(res, 400, result.error);

    return sendSuccess(res, 201, {
        data: formatBooking(result.booking),
        fareBreakdown: result.pricing.fareBreakdown,
        distanceMiles: result.pricing.distanceMiles,
        account: result.accountResult.user ? {
            created:               result.accountResult.accountCreated,
            linkedExistingAccount: result.accountResult.linkedExistingAccount,
            token:                 result.accountResult.token,
            user: {
                id:        result.accountResult.user.id,
                firstName: result.accountResult.user.firstName,
                lastName:  result.accountResult.user.lastName,
                email:     result.accountResult.user.email,
                phone:     result.accountResult.user.phone,
                location:  result.accountResult.user.location,
                role:      result.accountResult.user.role,
            },
        } : null,
    });
});

// ─── CREATE GUEST BOOKING ─────────────────────────────────────────────────────

exports.createGuestBooking = asyncHandler(async (req, res) => {
    const raw           = sanitizeBookingInput(req.body);
    const stopLocations = raw.stopLocations || raw.stopLocation || [];
    delete raw.stopLocations;
    delete raw.stopLocation;

    const vehicleCategoryId = raw.vehicleCategory || raw.vehicleCategoryId;
    delete raw.vehicleCategory;

    if (!vehicleCategoryId) return sendError(res, 400, 'vehicleCategory is required');

    const bookerDetails = raw.bookerDetails || {};
    const bookerEmail   = raw.bookerEmail || bookerDetails.email;
    const bookerPhone   = raw.bookerPhone || bookerDetails.phone;
    if (!bookerEmail || !bookerPhone) {
        return sendError(res, 400, 'bookerDetails.email and bookerDetails.phone are required for booking');
    }

    const category = await prisma.vehicleCategory.findUnique({ where: { id: vehicleCategoryId } });
    if (!category) return sendError(res, 404, 'Vehicle category not found');

    const accountResult = req.user
        ? { userId: req.user.id, user: null, token: null, accountCreated: false, linkedExistingAccount: false }
        : await createBookingUserIfRequested(raw);

    if (accountResult.error) return sendError(res, 400, accountResult.error);

    const data = buildBookingData(raw);
    data.userId           = accountResult.userId || undefined;
    data.isGuest          = !accountResult.userId;
    data.vehicleCategoryId = vehicleCategoryId;
    data.rideStatus       = data.rideStatus || 'upcoming';
    data.confNumber       = data.confNumber || generateConfNumber();

    // Calculate distance and fare if locations available
    let distanceMiles = 0;
    let fareBreakdown = null;
    try {
        if (raw.pickupLocation && raw.dropoffLocation) {
            const distanceResult = await calculateDistance(raw.pickupLocation, raw.dropoffLocation, stopLocations);
            distanceMiles = distanceResult.distanceMiles;

            const tripFare = calculateTotalFare(
                raw.type,
                distanceMiles,
                raw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            const tollCharges = calculateToll(distanceMiles);

            fareBreakdown = calculateFareBreakdown(
                raw.type,
                distanceMiles,
                raw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            data.distanceMiles = distanceMiles;
            data.tripPrice     = tripFare;
            data.tollCharges   = tollCharges;
        } else {
            data.tripPrice   = category.baseFare;
            data.tollCharges = 0;
        }
    } catch (error) {
        console.error('Distance calculation error in createGuestBooking:', error);
        data.tripPrice   = category.baseFare;
        data.tollCharges = 0;
    }

    data.childSeatsFee = data.childSeatsFee || 0;
    data.otherFees     = data.otherFees || 0;
    data.totalAmount   = parseFloat((data.tripPrice + data.tollCharges + data.childSeatsFee + data.otherFees).toFixed(2));

    const booking = await prisma.booking.create({
        data: { ...data, stopLocations: { create: stopLocations.map((loc) => ({ location: loc })) } },
        include: bookingInclude,
    });

    return sendSuccess(res, 201, {
        data: formatBooking(booking),
        fareBreakdown,
        distanceMiles,
        account: accountResult.user ? {
            created:               accountResult.accountCreated,
            linkedExistingAccount: accountResult.linkedExistingAccount,
            token:                 accountResult.token,
            user: {
                id:        accountResult.user.id,
                firstName: accountResult.user.firstName,
                lastName:  accountResult.user.lastName,
                email:     accountResult.user.email,
                phone:     accountResult.user.phone,
                location:  accountResult.user.location,
                role:      accountResult.user.role,
            },
        } : null,
    });
});

// ─── GET MY BOOKINGS ──────────────────────────────────────────────────────────

exports.getMyBookings = asyncHandler(async (req, res) => {
    const tab   = req.query.tab || 'upcoming';
    const where = { userId: req.user.id, ...buildRideFilter(tab) };

    const bookings = await prisma.booking.findMany({ where, include: bookingInclude, orderBy: { createdAt: 'desc' } });

    return sendSuccess(res, 200, { tab, count: bookings.length, data: bookings.map(formatBooking) });
});

// ─── GET BOOKING BY ID ────────────────────────────────────────────────────────

exports.getBookingById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const booking = await prisma.booking.findUnique({ where: { id }, include: bookingInclude });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const isOwner          = booking.userId          === req.user.id;
    const isAssignedDriver = booking.assignedDriverId === req.user.id;
    if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Not authorized to view this booking');
    }

    return sendSuccess(res, 200, { data: formatBooking(booking) });
});

// ─── UPDATE BOOKING ───────────────────────────────────────────────────────────

exports.updateBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return sendError(res, 404, 'Booking not found');

    const isOwner          = existing.userId          === req.user.id;
    const isAssignedDriver = existing.assignedDriverId === req.user.id;
    if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Not authorized to update this booking');
    }

    const raw           = sanitizeBookingInput(req.body);
    const stopLocations = raw.stopLocations || raw.stopLocation;
    delete raw.stopLocations;
    delete raw.stopLocation;

    if (raw.vehicleCategory) {
        raw.vehicleCategoryId = raw.vehicleCategory;
        delete raw.vehicleCategory;
    }

    const data = buildBookingData(raw);

    const updatePayload = {
        data: {
            ...data,
            ...(stopLocations !== undefined && {
                stopLocations: {
                    deleteMany: {},
                    create:     stopLocations.map((loc) => ({ location: loc })),
                },
            }),
        },
        where:   { id },
        include: bookingInclude,
    };

    const booking = await prisma.booking.update(updatePayload);
    return sendSuccess(res, 200, { message: 'Booking updated', data: formatBooking(booking) });
});

// ─── UPDATE BOOKING (all-in-one alias) ───────────────────────────────────────

exports.updateBookingAllInOne = exports.updateBooking;

// ─── ASSIGN DRIVER (admin only) ───────────────────────────────────────────────

exports.assignDriverToBooking = asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Only admin can assign drivers');
    }

    const { id }       = req.params;
    const { driverId } = req.body;

    if (!driverId) return sendError(res, 400, 'driverId is required');

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return sendError(res, 404, 'Driver not found');

    const updated = await prisma.booking.update({
        where:   { id },
        data:    { assignedDriverId: driver.userId },
        include: bookingInclude,
    });

    let payout = { transferred: false, reason: 'booking_not_paid' };
    if (updated.paymentStatus === 'paid') {
        payout = await transferDriverPayoutForBooking(updated.id);
    }

    return sendSuccess(res, 200, { data: formatBooking(updated), payout });
});

// ─── DELETE BOOKING ───────────────────────────────────────────────────────────

exports.deleteBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const isOwner          = booking.userId          === req.user.id;
    const isAssignedDriver = booking.assignedDriverId === req.user.id;
    if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Not authorized to delete this booking');
    }

    await prisma.booking.delete({ where: { id } });
    return sendSuccess(res, 200, { message: 'Booking deleted' });
});
