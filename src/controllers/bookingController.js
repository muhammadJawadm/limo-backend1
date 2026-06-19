'use strict';

const { prisma } = require('../config/db');
const { buildRideFilter } = require('../utils/rideFilters');
const { createNotificationRecord } = require('../utils/notificationHelpers');
const bcrypt = require('bcrypt');
const { generateToken } = require('../utils/jwt');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { EMAIL_REGEX, validatePassengerDetails, validateBookerDetails } = require('../utils/validators');
const { calculateDistance } = require('../utils/googleMaps');
const { TAX_RATE, calculateTax, calculateTotalFare, calculateFareBreakdown, calculateToll } = require('../utils/fareCalculation');
// Child seat rates (USD) — adjust as needed or move to env/config
const CHILD_SEAT_RATES = {
    infant: 15, // per infant seat
    toddler: 10, // per toddler seat
    booster: 8, // per booster seat
};

// Prisma returns Decimal fields as Decimal objects; convert to JS number for arithmetic
const toNum = (v) => (v == null ? 0 : Number(v));

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
    delete data.rideStatus;
    return data;
};

const generateConfNumber = () => {
    const timePart = Date.now().toString().slice(-6);
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
        const isOwner = booking.userId === req.user.id;
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
    if (!raw.type) return 'type is required';
    if (!['ptop', 'hourly'].includes(raw.type)) return 'type must be ptop or hourly';
    if (!raw.pickupLocation) return 'pickupLocation is required';
    if (!raw.dropoffLocation) return 'dropoffLocation is required';
    if (!raw.date) return 'date is required';
    if (!raw.time) return 'time is required';
    if (raw.type === 'hourly') {
        if (raw.hours === undefined || raw.hours === null) return 'hours is required for hourly bookings';
        if (Number(raw.hours) <= 0) return 'hours must be greater than 0';
    }
    const bookingDate = new Date(raw.date);
    if (isNaN(bookingDate.getTime())) return 'date must be a valid date';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (bookingDate < today) return 'Booking date must be today or in the future';
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
    if (
        !booking.bookerFirstName ||
        !booking.bookerLastName ||
        !booking.bookerEmail ||
        !booking.bookerPhone
    ) {
        return 'Booker details are missing';
    }

    return null;
};

const getGuestAccountPayload = (raw) => {
    const accountDetails = raw.accountDetails || {};
    const firstName = accountDetails.firstName || raw.accountFirstName || raw.bookerDetails?.firstName || raw.bookerFirstName;
    const lastName = accountDetails.lastName || raw.accountLastName || raw.bookerDetails?.lastName || raw.bookerLastName;
    const email = accountDetails.email || raw.accountEmail || raw.bookerDetails?.email || raw.bookerEmail;
    const phone = accountDetails.phone || raw.accountPhone || raw.bookerDetails?.phone || raw.bookerPhone;
    const password = accountDetails.password || raw.accountPassword || raw.password;
    const location = accountDetails.location || raw.accountLocation || raw.location || raw.pickupLocation;
    const createAccount = raw.createAccount === true || Boolean(password);
    return { createAccount, firstName, lastName, email, phone, password, location };
};

const pickDefinedValue = (preferred, fallback) => {
    return preferred !== undefined && preferred !== null && preferred !== '' ? preferred : fallback;
};

const getAuthenticatedUserDetails = async (userId) => {
    if (!userId) return null;

    return prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, email: true, phone: true },
    });
};

const hydrateContactDetails = async (req, raw, options = {}) => {
    const data = { ...raw };
    const bookerDetails = { ...(data.bookerDetails || {}) };

    if (req.user) {
        const user = await getAuthenticatedUserDetails(req.user.id);
        if (user) {
            data.bookerDetails = {
                firstName: pickDefinedValue(bookerDetails.firstName, user.firstName),
                lastName: pickDefinedValue(bookerDetails.lastName, user.lastName),
                email: pickDefinedValue(bookerDetails.email, user.email),
                phone: pickDefinedValue(bookerDetails.phone, user.phone),
            };
        }
        return data;
    }


    data.bookerDetails = bookerDetails;

    return data;
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
            lastName: accountPayload.lastName.trim(),
            email: normalizedEmail,
            phone: normalizedPhone,
            password: hashedPassword,
            location: accountPayload.location ? accountPayload.location.trim() : accountPayload.location,
            role: 'customer',
        },
    });
    return { userId: user.id, user, token: generateToken(user.id), accountCreated: true, linkedExistingAccount: false };
};

const buildBookingData = (payload) => {
    const data = {};
    const directFields = [
        'type', 'pickupLocation', 'dropoffLocation', 'date', 'time', 'hours', 'vehicleCategoryId',
        'assignedDriverId', 'confNumber', 'rideStatus', 'totalAmount', 'flightNumber', 'noOfPassengers',
        'luggage', 'childSeatRequired', 'isGuest', 'userId', 'specialInstructions', 'paymentStatus',
        'paymentIntentId', 'paymentMethodId', 'cardBrand', 'chargeId', 'receiptUrl', 'paymentConfirmedAt', 'platformFee', 'driverAmount', 'tripPrice', 'tollCharges', 'taxAmount', 'otherFees', 'childSeatInfant',
        'childSeatToddler', 'childSeatBooster', 'bookerFirstName', 'bookerLastName', 'bookerEmail', 'bookerPhone',
    ];
    for (const field of directFields) {
        if (payload[field] !== undefined) data[field] = payload[field];
    }
    if (payload.date !== undefined) {
        data.date = normalizeBookingDate(payload.date);
    }
    if (payload.childSeats) {
        if (payload.childSeats.infant !== undefined) data.childSeatInfant = payload.childSeats.infant;
        if (payload.childSeats.toddler !== undefined) data.childSeatToddler = payload.childSeats.toddler;
        if (payload.childSeats.booster !== undefined) data.childSeatBooster = payload.childSeats.booster;
    }

    if (payload.bookerDetails) {
        if (payload.bookerDetails.firstName !== undefined) data.bookerFirstName = payload.bookerDetails.firstName;
        if (payload.bookerDetails.lastName !== undefined) data.bookerLastName = payload.bookerDetails.lastName;
        if (payload.bookerDetails.email !== undefined) data.bookerEmail = payload.bookerDetails.email;
        if (payload.bookerDetails.phone !== undefined) data.bookerPhone = payload.bookerDetails.phone;
    }
    if (payload.chargesAndFees) {
        if (payload.chargesAndFees.tripPrice !== undefined) data.tripPrice = payload.chargesAndFees.tripPrice;
        if (payload.chargesAndFees.tollCharges !== undefined) data.tollCharges = payload.chargesAndFees.tollCharges;
        if (payload.chargesAndFees.childSeatsFee !== undefined) data.childSeatsFee = payload.chargesAndFees.childSeatsFee;
        if (payload.chargesAndFees.otherFees !== undefined) data.otherFees = payload.chargesAndFees.otherFees;
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
            const taxAmount = calculateTax(tripFare + tollCharges);

            fareBreakdown = calculateFareBreakdown(
                raw.type,
                distanceMiles,
                raw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );
            fareBreakdown.tollCharges = tollCharges;
            fareBreakdown.taxRate = parseFloat((TAX_RATE * 100).toFixed(4));
            fareBreakdown.taxAmount = taxAmount;
            fareBreakdown.total = parseFloat((tripFare + tollCharges + taxAmount).toFixed(2));

            return {
                distanceMiles,
                fareBreakdown,
                tripPrice: tripFare,
                tollCharges,
                taxAmount,
            };
        }

        const fallbackTripPrice = toNum(category.baseFare);
        const fallbackTax = calculateTax(fallbackTripPrice);
        return {
            distanceMiles: 0,
            fareBreakdown: null,
            tripPrice: fallbackTripPrice,
            tollCharges: 0,
            taxAmount: fallbackTax,
        };
    } catch (error) {
        console.error(`Distance calculation error in ${logLabel}:`, error);
        const fallbackTripPrice = toNum(category.baseFare);
        const fallbackTax = calculateTax(fallbackTripPrice);
        return {
            distanceMiles: 0,
            fareBreakdown: null,
            tripPrice: fallbackTripPrice,
            tollCharges: 0,
            taxAmount: fallbackTax,
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

    const contactHydratedRaw = await hydrateContactDetails(req, raw);
    const bookerDetails = contactHydratedRaw.bookerDetails || {};

    if (!req.user) {
        if (
            !bookerDetails.firstName ||
            !bookerDetails.lastName ||
            !bookerDetails.email ||
            !bookerDetails.phone
        ) {
            return {
                error:
                    'bookerDetails.firstName, bookerDetails.lastName, bookerDetails.email, and bookerDetails.phone are required',
            };
        }
    }
    const data = buildBookingData(contactHydratedRaw);
    data.userId = accountResult.userId || undefined;
    data.isGuest = options.allowGuestFlow ? !accountResult.userId : false;
    data.vehicleCategoryId = vehicleCategoryId;
    data.rideStatus = 'pending_payment';
    data.confNumber = data.confNumber || generateConfNumber();

    const pricing = await calculateBookingPricing(contactHydratedRaw, category, stopLocations, options.logLabel || 'createBookingFromPayload');
    data.distanceMiles = pricing.distanceMiles;
    data.tripPrice = pricing.tripPrice;
    data.tollCharges = pricing.tollCharges;
    data.taxAmount = pricing.taxAmount;
    data.childSeatsFee = 0;
    data.otherFees = data.otherFees || 0;
    data.totalAmount = parseFloat((data.tripPrice + data.tollCharges + data.taxAmount + data.otherFees).toFixed(2));

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
        taxAmount: booking.taxAmount || 0,
        childSeatsFee: 0,
        otherFees: booking.otherFees || 0,
        // Nested objects for convenience
        childSeats: {
            infant: booking.childSeatInfant || 0,
            toddler: booking.childSeatToddler || 0,
            booster: booking.childSeatBooster || 0,
        },
        bookerDetails: {
            firstName: booking.bookerFirstName,
            lastName: booking.bookerLastName,
            email: booking.bookerEmail,
            phone: booking.bookerPhone,
        },

        assignedDriver: booking.assignedDriver
            ? {
                id: booking.assignedDriver.id,
                firstName: booking.assignedDriver.firstName,
                lastName: booking.assignedDriver.lastName,
                fullName: [
                    booking.assignedDriver.firstName,
                    booking.assignedDriver.lastName,
                ].filter(Boolean).join(' '),
                email: booking.assignedDriver.email,
                phone: booking.assignedDriver.phone,
                profilePictureUrl: booking.assignedDriver.driver?.requiredDocuments?.profilePictureUrl || null,
            }
            : null,
        // Stripe payment details at root
        paymentMethodId: booking.paymentMethodId || null,
        isGuest: booking.isGuest,
        cardBrand: booking.cardBrand || null,
        chargeId: booking.chargeId || null,
        receiptUrl: booking.receiptUrl || null,
        paymentConfirmedAt: booking.paymentConfirmedAt || null,
        stopLocations: booking.stopLocations?.map((s) => s.location) || [],
    };
};

const bookingInclude = {
    vehicleCategory: true,
    stopLocations: true,
    assignedDriver: { select: { id: true, firstName: true, lastName: true, email: true, phone: true , driver:{select:{requiredDocuments: {select:{profilePictureUrl: true}}}} } },
    user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
};

// ─── STEP 1: CREATE BOOKING ───────────────────────────────────────────────────

exports.createBookingStep1 = asyncHandler(async (req, res) => {
    const raw = sanitizeBookingInput(req.body, { allowGuest: true });
    const stopLocations = normalizeStopLocations(raw);

    const step1Error = validateStep1Payload(raw);
    if (step1Error) return sendError(res, 400, step1Error);



    const data = buildBookingData(raw);
    data.userId = req.user ? req.user.id : undefined;
    data.isGuest = !req.user;
    data.rideStatus = 'pending_payment';
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

    const raw = sanitizeBookingInput(req.body);
    const vehicleCategoryId = raw.vehicleCategory || raw.vehicleCategoryId;
    delete raw.vehicleCategory;

    if (!vehicleCategoryId) return sendError(res, 400, 'vehicleCategoryId is required');
    if (raw.noOfPassengers === undefined || raw.noOfPassengers === null) return sendError(res, 400, 'noOfPassengers is required');
    if (raw.luggage === undefined || raw.luggage === null) return sendError(res, 400, 'luggage is required');

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

        const taxAmount = calculateTax(tripFare + tollCharges);
        fareBreakdown.tollCharges = tollCharges;
        fareBreakdown.taxRate = parseFloat((TAX_RATE * 100).toFixed(4));
        fareBreakdown.taxAmount = taxAmount;
        fareBreakdown.total = parseFloat((tripFare + tollCharges + taxAmount).toFixed(2));

        const data = buildBookingData(raw);
        data.vehicleCategoryId = vehicleCategoryId;
        data.distanceMiles = distanceMiles;
        data.tripPrice = tripFare;
        data.tollCharges = tollCharges;
        data.taxAmount = taxAmount;
        data.childSeatsFee = 0;
        data.otherFees = toNum(existing.otherFees);
        data.totalAmount = parseFloat((tripFare + tollCharges + taxAmount + data.otherFees).toFixed(2));

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
        data.tripPrice = toNum(category.baseFare);
        data.tollCharges = 0;
        data.taxAmount = calculateTax(data.tripPrice);
        data.childSeatsFee = 0;
        data.otherFees = toNum(existing.otherFees);
        data.totalAmount = parseFloat((data.tripPrice + data.taxAmount + data.otherFees).toFixed(2));

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

    const raw = sanitizeBookingInput(req.body);
    const childSeats = raw.childSeats || {};

    const infantCount =
        raw.childSeatInfant !== undefined
            ? raw.childSeatInfant
            : childSeats.infant !== undefined
                ? childSeats.infant
                : existing.childSeatInfant || 0;

    const toddlerCount =
        raw.childSeatToddler !== undefined
            ? raw.childSeatToddler
            : childSeats.toddler !== undefined
                ? childSeats.toddler
                : existing.childSeatToddler || 0;

    const boosterCount =
        raw.childSeatBooster !== undefined
            ? raw.childSeatBooster
            : childSeats.booster !== undefined
                ? childSeats.booster
                : existing.childSeatBooster || 0;

    const tripPrice = toNum(existing.tripPrice);
    const tollCharges = toNum(existing.tollCharges);
    const otherFees = toNum(existing.otherFees);
    const taxAmount = toNum(existing.taxAmount) || calculateTax(tripPrice + tollCharges);

    const payload = {
        childSeatRequired:
            raw.childSeatRequired !== undefined
                ? raw.childSeatRequired
                : infantCount > 0 || toddlerCount > 0 || boosterCount > 0,

        childSeatInfant: infantCount,
        childSeatToddler: toddlerCount,
        childSeatBooster: boosterCount,

        childSeatsFee: 0,
        tripPrice,
        tollCharges,
        taxAmount,
        otherFees,
        totalAmount: parseFloat((tripPrice + tollCharges + taxAmount + otherFees).toFixed(2)),
    };

    const booking = await prisma.booking.update({
        where: { id },
        data: payload,
        include: bookingInclude,
    });

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
    const hydratedRaw = await hydrateContactDetails(req, raw);

    const bookerDetails = hydratedRaw.bookerDetails || {};

    if (
        !bookerDetails.firstName ||
        !bookerDetails.lastName ||
        !bookerDetails.email ||
        !bookerDetails.phone
    ) {
        return sendError(res, 400, 'bookerDetails.firstName, bookerDetails.lastName, bookerDetails.email, and bookerDetails.phone are required');
    }

    const booking = await prisma.booking.update({
        where: { id },
        data: buildBookingData(hydratedRaw),
        include: bookingInclude,
    });

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

    const raw = sanitizeBookingInput(req.body);
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
    const result = await createBookingFromPayload(req, raw, { allowGuestFlow: false, logLabel: 'createBookingAllInOne' });
    if (result.error) return sendError(res, 400, result.error);

    return sendSuccess(res, 201, {
        data: formatBooking(result.booking),
        fareBreakdown: result.pricing.fareBreakdown,
        distanceMiles: result.pricing.distanceMiles,
        account: result.accountResult.user ? {
            created: result.accountResult.accountCreated,
            linkedExistingAccount: result.accountResult.linkedExistingAccount,
            token: result.accountResult.token,
            user: {
                id: result.accountResult.user.id,
                firstName: result.accountResult.user.firstName,
                lastName: result.accountResult.user.lastName,
                email: result.accountResult.user.email,
                phone: result.accountResult.user.phone,
                location: result.accountResult.user.location,
                role: result.accountResult.user.role,
            },
        } : null,
    });
});

// ─── CREATE GUEST BOOKING ─────────────────────────────────────────────────────

exports.createGuestBooking = asyncHandler(async (req, res) => {
    const raw = sanitizeBookingInput(req.body);
    const stopLocations = raw.stopLocations || raw.stopLocation || [];
    delete raw.stopLocations;
    delete raw.stopLocation;

    const vehicleCategoryId = raw.vehicleCategory || raw.vehicleCategoryId;
    delete raw.vehicleCategory;

    if (!vehicleCategoryId) return sendError(res, 400, 'vehicleCategory is required');

    const bookerDetails = raw.bookerDetails || {};
    const bookerEmail = raw.bookerEmail || bookerDetails.email;
    const bookerPhone = raw.bookerPhone || bookerDetails.phone;

    if (!bookerEmail || !bookerPhone) {
        return sendError(res, 400, 'bookerDetails.email and bookerDetails.phone are required for booking');
    }

    const category = await prisma.vehicleCategory.findUnique({ where: { id: vehicleCategoryId } });
    if (!category) return sendError(res, 404, 'Vehicle category not found');

    const accountResult = req.user
        ? { userId: req.user.id, user: null, token: null, accountCreated: false, linkedExistingAccount: false }
        : await createBookingUserIfRequested(raw);

    if (accountResult.error) return sendError(res, 400, accountResult.error);

    const hydratedRaw = await hydrateContactDetails(req, raw);
    const data = buildBookingData(hydratedRaw);
    data.userId = accountResult.userId || undefined;
    data.isGuest = !accountResult.userId;
    data.vehicleCategoryId = vehicleCategoryId;
    data.rideStatus = 'pending_payment';
    data.confNumber = data.confNumber || generateConfNumber();

    // Calculate distance and fare if locations available
    let distanceMiles = 0;
    let fareBreakdown = null;
    try {
        if (hydratedRaw.pickupLocation && hydratedRaw.dropoffLocation) {
            const distanceResult = await calculateDistance(hydratedRaw.pickupLocation, hydratedRaw.dropoffLocation, stopLocations);
            distanceMiles = distanceResult.distanceMiles;

            const tripFare = calculateTotalFare(
                hydratedRaw.type,
                distanceMiles,
                hydratedRaw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            const tollCharges = calculateToll(distanceMiles);

            fareBreakdown = calculateFareBreakdown(
                hydratedRaw.type,
                distanceMiles,
                hydratedRaw.hours,
                category.baseFare,
                category.perMileRate30,
                category.perMileRate40,
                category.perHour
            );

            data.distanceMiles = distanceMiles;
            data.tripPrice = tripFare;
            data.tollCharges = tollCharges;

            if (fareBreakdown) {
                fareBreakdown.tollCharges = tollCharges;
                fareBreakdown.taxRate = parseFloat((TAX_RATE * 100).toFixed(4));
                fareBreakdown.taxAmount = calculateTax(tripFare + tollCharges);
                fareBreakdown.total = parseFloat((tripFare + tollCharges + fareBreakdown.taxAmount).toFixed(2));
            }
        } else {
            data.tripPrice = toNum(category.baseFare);
            data.tollCharges = 0;
        }
    } catch (error) {
        console.error('Distance calculation error in createGuestBooking:', error);
        data.tripPrice = toNum(category.baseFare);
        data.tollCharges = 0;
    }

    data.childSeatsFee = 0;
    data.otherFees = data.otherFees || 0;
    data.taxAmount = calculateTax(data.tripPrice + data.tollCharges);
    data.totalAmount = parseFloat((data.tripPrice + data.tollCharges + data.taxAmount + data.otherFees).toFixed(2));

    const booking = await prisma.booking.create({
        data: { ...data, stopLocations: { create: stopLocations.map((loc) => ({ location: loc })) } },
        include: bookingInclude,
    });

    return sendSuccess(res, 201, {
        data: formatBooking(booking),
        fareBreakdown,
        distanceMiles,
        account: accountResult.user ? {
            created: accountResult.accountCreated,
            linkedExistingAccount: accountResult.linkedExistingAccount,
            token: accountResult.token,
            user: {
                id: accountResult.user.id,
                firstName: accountResult.user.firstName,
                lastName: accountResult.user.lastName,
                email: accountResult.user.email,
                phone: accountResult.user.phone,
                location: accountResult.user.location,
                role: accountResult.user.role,
            },
        } : null,
    });
});

// ─── GET MY BOOKINGS ──────────────────────────────────────────────────────────

exports.getMyBookings = asyncHandler(async (req, res) => {
    const tab = req.query.tab || 'upcoming';
    const where = { userId: req.user.id, rideStatus: { not: 'pending_payment' }, ...buildRideFilter(tab) };

    const bookings = await prisma.booking.findMany({ where, include: bookingInclude, orderBy: { createdAt: 'desc' } });

    return sendSuccess(res, 200, { tab, count: bookings.length, data: bookings.map(formatBooking) });
});

// ─── GET BOOKING BY ID ────────────────────────────────────────────────────────

exports.getBookingById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const booking = await prisma.booking.findUnique({ where: { id }, include: bookingInclude });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const isOwner = booking.userId === req.user.id;
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

    const isOwner = existing.userId === req.user.id;
    const isAssignedDriver = existing.assignedDriverId === req.user.id;
    if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Not authorized to update this booking');
    }

    const raw = sanitizeBookingInput(req.body);
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
                    create: stopLocations.map((loc) => ({ location: loc })),
                },
            }),
        },
        where: { id },
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

    const { id } = req.params;
    const { driverId } = req.body;

    if (!driverId) return sendError(res, 400, 'driverId is required');

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return sendError(res, 404, 'Booking not found');
    if (booking.rideStatus === 'pending_payment') {
        return sendError(res, 400, 'Cannot assign driver: booking payment has not been completed');
    }

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return sendError(res, 404, 'Driver not found');

    const updated = await prisma.booking.update({
        where: { id },
        data: { assignedDriverId: driver.userId, rideStatus: 'upcoming', },
        include: bookingInclude,
    });

    const notifications = [];

    if (booking.userId) {
        notifications.push(
            createNotificationRecord({
                recipientRole: 'customer',
                recipientUserId: booking.userId,
                title: 'Ride assigned',
                message: `Your ride ${booking.confNumber || id} has been assigned to a driver.`,
                type: 'ride_assigned',
                meta: { rideId: id, driverId: driver.userId, status: 'assigned', assignedBy: 'admin' },
            }),
        );
    }

    notifications.push(
        createNotificationRecord({
            recipientRole: 'driver',
            recipientUserId: driver.userId,
            title: 'New ride assigned',
            message: `You have been assigned to ride ${booking.confNumber || id}.`,
            type: 'ride_assigned',
            meta: { rideId: id, customerId: booking.userId || null, status: 'assigned', assignedBy: 'admin' },
        }),
    );

    await Promise.all(notifications);

    return sendSuccess(res, 200, { data: formatBooking(updated) });
});

// ─── DELETE BOOKING ───────────────────────────────────────────────────────────

exports.deleteBooking = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const isOwner = booking.userId === req.user.id;
    const isAssignedDriver = booking.assignedDriverId === req.user.id;
    if (!isOwner && !isAssignedDriver && req.user.role !== 'admin') {
        return sendError(res, 403, 'Forbidden: Not authorized to delete this booking');
    }

    await prisma.booking.delete({ where: { id } });
    return sendSuccess(res, 200, { message: 'Booking deleted' });
});
