'use strict';

const { prisma } = require('../config/db');
const { uploadToCloudinary } = require('../utils/cloudinaryUpload');
const { buildRideFilter } = require('../utils/rideFilters');
const { createNotificationRecord } = require('../utils/notificationHelpers');
const { transferDriverPayoutForBooking } = require('./paymentController');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { TRAINING_DEFAULTS } = require('../utils/constants');

// ─── INCLUDE CONFIG ───────────────────────────────────────────────────────────
const driverInclude = {
    trainingModules: { orderBy: { moduleNumber: 'asc' } },
    requiredDocuments: true,
    vehicles: true,
};

const rideInclude = {
    vehicleCategory: true,
    stopLocations: true,
    user: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    },
    assignedDriver: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    },
};

const normalizeExpiry = (value) => {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            return new Date(`${trimmed}T00:00:00.000Z`);
        }

        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    return null;
};

const documentFieldKeys = {
    url: [
        'w9FormUrl',
        'articleOfIncorporationUrl',
        'einCertificateUrl',
        'cityPermitUrl',
        'voidCheckUrl',
        'profilePictureUrl',
        'licensePictureUrl',
        'limoLicenseDecalUrl',
        'liabilityInsuranceUrl',
        'vehicleRegistrationUrl',
        'cityPermittedStickerUrl',
        'licensePlatePhotoUrl',
        'airportPermitUrl',
    ],
    expiry: [
        'w9FormExpiry',
        'articleOfIncorporationExpiry',
        'einCertificateExpiry',
        'cityPermitExpiry',
        'voidCheckExpiry',
        'profilePictureExpiry',
        'licensePictureExpiry',
        'limoLicenseDecalExpiry',
        'liabilityInsuranceExpiry',
        'vehicleRegistrationExpiry',
        'cityPermittedStickerExpiry',
        'licensePlatePhotoExpiry',
        'airportPermitExpiry',
    ],
    status: [
        'w9FormStatus',
        'articleOfIncorporationStatus',
        'einCertificateStatus',
        'cityPermitStatus',
        'voidCheckStatus',
        'profilePictureStatus',
        'licensePictureStatus',
        'limoLicenseDecalStatus',
        'liabilityInsuranceStatus',
        'vehicleRegistrationStatus',
        'cityPermittedStickerStatus',
        'licensePlatePhotoStatus',
        'airportPermitStatus',
    ],
};

const buildDocumentUpdateData = (docData) => {
    const update = {};
    const allFields = [...documentFieldKeys.url, ...documentFieldKeys.expiry, ...documentFieldKeys.status];
    for (const key of allFields) {
        if (docData[key] === undefined) continue;
        update[key] = documentFieldKeys.expiry.includes(key)
            ? normalizeExpiry(docData[key])
            : docData[key];
    }
    return update;
};

const buildDocumentCreateData = (docData) => {
    const create = {};
    for (const key of documentFieldKeys.status) {
        create[key] = docData[key] !== undefined ? docData[key] : 'missing';
    }
    for (const key of [...documentFieldKeys.url, ...documentFieldKeys.expiry]) {
        if (docData[key] === undefined) continue;
        create[key] = documentFieldKeys.expiry.includes(key)
            ? normalizeExpiry(docData[key])
            : docData[key];
    }
    return create;
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const getDriverForUser = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { error: { code: 404, message: 'User not found' } };
    if (user.role !== 'driver') return { error: { code: 403, message: 'Only driver accounts can access partner onboarding' } };

    let driver = await prisma.driver.findUnique({
        where: { userId: user.id },
        include: driverInclude,
    });

    if (!driver) {
        driver = await prisma.driver.create({
            data: {
                userId: user.id,
                companyName: user.companyName || 'Pending',
                companyType: 'Pending',
                taxIdentificationNumber: 'Pending',
                businessRegistrationNumber: 'Pending',
                trainingTotalModules: TRAINING_DEFAULTS.length,
                trainingCompletedModules: 0,
                trainingIsComplete: false,
                trainingModules: {
                    create: TRAINING_DEFAULTS.map((m) => ({
                        moduleNumber: m.moduleNumber,
                        title: m.title,
                        progressPercentage: 0,
                        completed: false,
                    })),
                },
            },
            include: driverInclude,
        });
    }

    return { user, driver };
};

const buildDriverProfileView = (user, driver) => ({
    user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        location: user.location,
        role: user.role,
        companyName: user.companyName,
        isVerified: user.isVerified,
        onboardingCompleted: user.onboardingCompleted,
    },
    onboardingStatus: {
        submittedApplication: driver.submittedApplication,
        submittedAt: driver.submittedAt,
    },
});

const formatDriver = (driver) => {
    if (!driver) return null;
    return {
        ...driver,
        companyAddress: {
            country: driver.companyCountry,
            city: driver.companyCity,
            street: driver.companyStreet,
            postalCode: driver.companyPostalCode,
            state: driver.companyState,
        },
        fleetInformation: {
            priorLimoExperience: driver.priorLimoExperience,
            electricVehicleFleet: driver.electricVehicleFleet,
            femaleChauffeurs: driver.femaleChauffeurs,
            numberOfChauffeurs: driver.numberOfChauffeurs,
            numberOfFirstClassVehicles: driver.numberOfFirstClassVehicles,
            numberOfBusinessClassVans: driver.numberOfBusinessClassVans,
            businessClassVansDescription: driver.businessClassVansDescription,
        },
        firstChauffeurInformation: {
            useAuthorizedRepresentativeDetails: driver.useAuthorizedRepresentativeDetails,
            firstName: driver.chauffeurFirstName,
            lastName: driver.chauffeurLastName,
            email: driver.chauffeurEmail,
            phone: driver.chauffeurPhone,
            driverLicenseId: driver.chauffeurDriverLicenseId,
        },
        firstVehicleInformation: {
            yearOfManufacture: driver.vehicleYearOfManufacture,
            brandAndModel: driver.vehicleBrandAndModel,
            vehicleClass: driver.vehicleClass,
            color: driver.vehicleColor,
            passengerCapacity: driver.vehiclePassengerCapacity,
            luggageCapacity: driver.vehicleLuggageCapacity,
            wifi: driver.vehicleWifi,
            vehicleNumberPlate: driver.vehicleNumberPlate,
            vehicleVIN: driver.vehicleVIN,
        },
        contractAgreement: {
            signed: driver.contractSigned,
            confirmationAgreement: driver.contractConfirmationAgreement,
            place: driver.contractPlace,
        },
        availability: {
            timeZone: driver.availabilityTimeZone,
            submittedApplication: driver.submittedApplication,
            submittedAt: driver.submittedAt,
            notes: driver.availabilityNotes,
            weeklySchedule: {
                monday: { enabled: driver.mondayEnabled, startTime: driver.mondayStart, endTime: driver.mondayEnd },
                tuesday: { enabled: driver.tuesdayEnabled, startTime: driver.tuesdayStart, endTime: driver.tuesdayEnd },
                wednesday: { enabled: driver.wednesdayEnabled, startTime: driver.wednesdayStart, endTime: driver.wednesdayEnd },
                thursday: { enabled: driver.thursdayEnabled, startTime: driver.thursdayStart, endTime: driver.thursdayEnd },
                friday: { enabled: driver.fridayEnabled, startTime: driver.fridayStart, endTime: driver.fridayEnd },
                saturday: { enabled: driver.saturdayEnabled, startTime: driver.saturdayStart, endTime: driver.saturdayEnd },
                sunday: { enabled: driver.sundayEnabled, startTime: driver.sundayStart, endTime: driver.sundayEnd },
            },
        },
        partnerTraining: {
            totalModules: driver.trainingTotalModules,
            completedModules: driver.trainingCompletedModules,
            isComplete: driver.trainingIsComplete,
            modules: driver.trainingModules || [],
        },
    };
};

const getOnboardingStepData = (driver, step) => {
    const formatted = formatDriver(driver);
    const stepDataMap = {
        'company-information': {
            companyName: driver.companyName,
            companyType: driver.companyType,
            companyAddress: formatted.companyAddress,
            taxIdentificationNumber: driver.taxIdentificationNumber,
            businessRegistrationNumber: driver.businessRegistrationNumber,
        },
        'fleet-information': formatted.fleetInformation,
        'first-chauffeur-information': formatted.firstChauffeurInformation,
        'first-vehicle-information': formatted.firstVehicleInformation,
        'required-documents': driver.requiredDocuments,
        'partner-training': formatted.partnerTraining,
        'contract-agreement': formatted.contractAgreement,
        'payment-information': {
            stripeAccountId: driver.stripeAccountId,
            stripeOnboarded: driver.stripeOnboarded,
        },
        availability: formatted.availability,
    };
    return stepDataMap[step];
};

const mapRideForDriver = (booking) => {
    const user = booking.user || {};
    const passengerName = booking.userId
        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
        : `${booking.bookerFirstName || ''} ${booking.bookerLastName || ''}`.trim();
    return {
        id: booking.id,
        confNumber: booking.confNumber || `CNF-${booking.id.slice(-6).toUpperCase()}`,
        rideStatus: booking.rideStatus || 'upcoming',
        type: booking.type,
        date: booking.date,
        time: booking.time,
        passenger: {
            name: passengerName || 'Guest Booker',
            email: user.email || booking.bookerEmail || null,
            phone: user.phone || booking.bookerPhone || null,
        },
        routingInformation: {
            pickupLocation: booking.pickupLocation,
            stopLocations: booking.stopLocations?.map((s) => s.location) || [],
            dropoffLocation: booking.dropoffLocation,
        },
        noOfPassengers: booking.noOfPassengers,
        luggage: booking.luggage,
        childSeatRequired: booking.childSeatRequired,
        childSeats: {
            infant: booking.childSeatInfant,
            toddler: booking.childSeatToddler,
            booster: booking.childSeatBooster,
        },
        specialInstructions: booking.specialInstructions || '',
        flightNumber: booking.flightNumber || '',
        vehicleCategory: booking.vehicleCategory || null,
        totalAmount: Number(booking.totalAmount) || (Number(booking.tripPrice) + Number(booking.tollCharges) + Number(booking.otherFees)),
        assignedDriverId: booking.assignedDriverId || null,
        isGuest: booking.isGuest,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        chargesAndFees: {
            tripPrice: Number(booking.tripPrice) || 0,
            tollCharges: Number(booking.tollCharges) || 0,
            childSeatsFee: 0,
            otherFees: Number(booking.otherFees) || 0,
            paymentStatus: booking.paymentStatus || null,
            paymentIntentId: booking.paymentIntentId || null,
            paymentMethodId: booking.paymentMethodId || null,
        },
    };
};

const mapRideDetailsForDriver = (booking) => {
    const user = booking.user || {};
    const passengerName = booking.userId
        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
        : `${booking.bookerFirstName || ''} ${booking.bookerLastName || ''}`.trim();
    return {
        id: booking.id,
        confNumber: booking.confNumber || `CNF-${booking.id.slice(-6).toUpperCase()}`,
        rideStatus: booking.rideStatus || 'upcoming',
        type: booking.type,
        date: booking.date,
        time: booking.time,
        passenger: {
            name: passengerName || 'Guest Booker',
            email: user.email || booking.bookerEmail || null,
            phone: user.phone || booking.bookerPhone || null,
        },
        routingInformation: {
            pickupLocation: booking.pickupLocation,
            stopLocations: booking.stopLocations?.map((s) => s.location) || [],
            dropoffLocation: booking.dropoffLocation,
        },
        noOfPassengers: booking.noOfPassengers,
        luggage: booking.luggage,
        childSeatRequired: booking.childSeatRequired,
        childSeats: {
            infant: booking.childSeatInfant || 0,
            toddler: booking.childSeatToddler || 0,
            booster: booking.childSeatBooster || 0,
        },
        specialInstructions: booking.specialInstructions || '',
        flightNumber: booking.flightNumber || '',
        vehicleCategory: booking.vehicleCategory || null,
        totalAmount: Number(booking.totalAmount) || (Number(booking.tripPrice) + Number(booking.tollCharges) + Number(booking.otherFees)),
        assignedDriverId: booking.assignedDriverId || null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        chargesAndFees: {
            tripPrice: Number(booking.tripPrice) || 0,
            tollCharges: Number(booking.tollCharges) || 0,
            childSeatsFee: 0,
            otherFees: Number(booking.otherFees) || 0,
            paymentStatus: booking.paymentStatus || null,
            paymentIntentId: booking.paymentIntentId || null,
            paymentMethodId: booking.paymentMethodId || null,
        },
    };
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

exports.getMyOnboarding = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);
    return sendSuccess(res, 200, { data: formatDriver(driver) });
});

exports.getMyProfile = asyncHandler(async (req, res) => {
    const { error, user, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);
    return sendSuccess(res, 200, {
        data: {
            ...buildDriverProfileView(user, driver),
            onboarding: formatDriver(driver),
        },
    });
});

exports.updateMyPersonalInfo = asyncHandler(async (req, res) => {
    const { error, user } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { firstName, lastName, email, phone, location } = req.body || {};
    const userData = {};

    if (firstName !== undefined) userData.firstName = firstName;
    if (lastName !== undefined) userData.lastName = lastName;
    if (location !== undefined) userData.location = location;

    if (email !== undefined) {
        const normalizedEmail = String(email).toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return sendError(res, 400, 'Invalid email format');
        }
        if (normalizedEmail !== user.email) {
            const existingEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
            if (existingEmail) {
                return sendError(res, 400, 'Email already in use');
            }
        }
        userData.email = normalizedEmail;
    }

    if (phone !== undefined) {
        if (phone !== user.phone) {
            const existingPhone = await prisma.user.findUnique({ where: { phone } });
            if (existingPhone) {
                return sendError(res, 400, 'Phone number already in use');
            }
        }
        userData.phone = phone;
    }

    if (Object.keys(userData).length === 0) {
        return sendError(res, 400, 'No personal info fields provided');
    }

    const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: userData,
    });

    return sendSuccess(res, 200, {
        message: 'Personal information updated',
        data: {
            id: updatedUser.id,
            firstName: updatedUser.firstName,
            lastName: updatedUser.lastName,
            email: updatedUser.email,
            phone: updatedUser.phone,
            location: updatedUser.location,
            role: updatedUser.role,
            companyName: updatedUser.companyName,
            isVerified: updatedUser.isVerified,
            onboardingCompleted: updatedUser.onboardingCompleted,
        },
    });
});

exports.getMyOnboardingStep = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { step } = req.params;
    const data = getOnboardingStepData(driver, step);
    if (data === undefined) {
        return sendError(res, 404, 'Invalid onboarding step');
    }
    return sendSuccess(res, 200, { step, data });
});

exports.updateCompanyInformation = asyncHandler(async (req, res) => {
    const { error, user, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { companyName, companyType, companyAddress, taxIdentificationNumber, businessRegistrationNumber } = req.body;

    const driverData = {};
    const userData = {};

    if (companyName !== undefined) { driverData.companyName = companyName; userData.companyName = companyName; }
    if (companyType !== undefined) driverData.companyType = companyType;
    if (taxIdentificationNumber !== undefined) driverData.taxIdentificationNumber = taxIdentificationNumber;
    if (businessRegistrationNumber !== undefined) driverData.businessRegistrationNumber = businessRegistrationNumber;
    if (companyAddress) {
        if (companyAddress.country !== undefined) driverData.companyCountry = companyAddress.country;
        if (companyAddress.city !== undefined) driverData.companyCity = companyAddress.city;
        if (companyAddress.street !== undefined) driverData.companyStreet = companyAddress.street;
        if (companyAddress.postalCode !== undefined) driverData.companyPostalCode = companyAddress.postalCode;
        if (companyAddress.state !== undefined) driverData.companyState = companyAddress.state;
    }

    const [updatedDriver] = await Promise.all([
        prisma.driver.update({ where: { id: driver.id }, data: driverData, include: driverInclude }),
        Object.keys(userData).length > 0
            ? prisma.user.update({ where: { id: user.id }, data: userData })
            : Promise.resolve(),
    ]);

    return sendSuccess(res, 200, { message: 'Company information updated', data: formatDriver(updatedDriver) });
});

exports.updateFleetInformation = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const body = req.body;
    const data = {};
    if (body.priorLimoExperience !== undefined) data.priorLimoExperience = body.priorLimoExperience;
    if (body.electricVehicleFleet !== undefined) data.electricVehicleFleet = body.electricVehicleFleet;
    if (body.femaleChauffeurs !== undefined) data.femaleChauffeurs = body.femaleChauffeurs;
    if (body.numberOfChauffeurs !== undefined) data.numberOfChauffeurs = body.numberOfChauffeurs;
    if (body.numberOfFirstClassVehicles !== undefined) data.numberOfFirstClassVehicles = body.numberOfFirstClassVehicles;
    if (body.numberOfBusinessClassVans !== undefined) data.numberOfBusinessClassVans = body.numberOfBusinessClassVans;
    if (body.businessClassVansDescription !== undefined) data.businessClassVansDescription = body.businessClassVansDescription;

    const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
    return sendSuccess(res, 200, { message: 'Fleet information updated', data: formatDriver(updatedDriver) });
});

exports.updateFirstChauffeurInformation = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const body = req.body;
    const data = {};
    if (body.useAuthorizedRepresentativeDetails !== undefined) data.useAuthorizedRepresentativeDetails = body.useAuthorizedRepresentativeDetails;
    if (body.firstName !== undefined) data.chauffeurFirstName = body.firstName;
    if (body.lastName !== undefined) data.chauffeurLastName = body.lastName;
    if (body.email !== undefined) data.chauffeurEmail = body.email;
    if (body.phone !== undefined) data.chauffeurPhone = body.phone;
    if (body.driverLicenseId !== undefined) data.chauffeurDriverLicenseId = body.driverLicenseId;

    const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
    return sendSuccess(res, 200, { message: 'First chauffeur information updated', data: formatDriver(updatedDriver) });
});

exports.updateFirstVehicleInformation = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const body = req.body;
    const data = {};
    if (body.yearOfManufacture !== undefined) data.vehicleYearOfManufacture = body.yearOfManufacture;
    if (body.brandAndModel !== undefined) data.vehicleBrandAndModel = body.brandAndModel;
    if (body.vehicleClass !== undefined) data.vehicleClass = body.vehicleClass;
    if (body.color !== undefined) data.vehicleColor = body.color;
    if (body.passengerCapacity !== undefined) data.vehiclePassengerCapacity = body.passengerCapacity;
    if (body.luggageCapacity !== undefined) data.vehicleLuggageCapacity = body.luggageCapacity;
    if (body.wifi !== undefined) data.vehicleWifi = body.wifi;
    if (body.vehicleNumberPlate !== undefined) data.vehicleNumberPlate = body.vehicleNumberPlate;
    if (body.vehicleVIN !== undefined) data.vehicleVIN = body.vehicleVIN;

    const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
    return sendSuccess(res, 200, { message: 'First vehicle information updated', data: formatDriver(updatedDriver) });
});

exports.updateRequiredDocuments = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const docData = req.body;

    await prisma.driverDocument.upsert({
        where: { driverId: driver.id },
        update: buildDocumentUpdateData(docData),
        create: { driverId: driver.id, ...buildDocumentCreateData(docData) },
    });

    const updatedDriver = await prisma.driver.findUnique({ where: { id: driver.id }, include: driverInclude });
    return sendSuccess(res, 200, { message: 'Required documents updated', data: formatDriver(updatedDriver) });
});

exports.updatePartnerTraining = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { modules } = req.body;
    if (!Array.isArray(modules)) {
        return sendError(res, 400, 'modules must be an array');
    }

    const completedModules = modules.filter((m) => m.completed === true).length;
    const isComplete = modules.length > 0 && completedModules === modules.length;

    await prisma.$transaction([
        prisma.trainingModule.deleteMany({ where: { driverId: driver.id } }),
        prisma.trainingModule.createMany({
            data: modules.map((m) => ({
                driverId: driver.id,
                moduleNumber: m.moduleNumber,
                title: m.title,
                progressPercentage: m.progressPercentage ?? 0,
                completed: m.completed ?? false,
            })),
        }),
        prisma.driver.update({
            where: { id: driver.id },
            data: {
                trainingTotalModules: modules.length,
                trainingCompletedModules: completedModules,
                trainingIsComplete: isComplete,
            },
        }),
    ]);

    const updatedDriver = await prisma.driver.findUnique({ where: { id: driver.id }, include: driverInclude });
    return sendSuccess(res, 200, { message: 'Partner training updated', data: formatDriver(updatedDriver) });
});

exports.updateContractAgreement = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { signed, confirmationAgreement, place } = req.body;
    const data = {};
    if (signed !== undefined) data.contractSigned = signed;
    if (confirmationAgreement !== undefined) data.contractConfirmationAgreement = confirmationAgreement;
    if (place !== undefined) data.contractPlace = place;

    const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
    return sendSuccess(res, 200, { message: 'Contract agreement updated', data: formatDriver(updatedDriver) });
});

exports.updatePaymentInformation = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { stripeAccountId, stripeOnboarded } = req.body;

    if (stripeAccountId === undefined && stripeOnboarded === undefined) {
        return sendError(res, 400, 'stripeAccountId or stripeOnboarded is required');
    }

    const data = {};
    if (stripeAccountId !== undefined) data.stripeAccountId = stripeAccountId;
    if (stripeOnboarded !== undefined) data.stripeOnboarded = stripeOnboarded;

    const updatedDriver = await prisma.driver.update({
        where: { id: driver.id },
        data,
        include: driverInclude,
    });
    return sendSuccess(res, 200, { message: 'Stripe payment status updated', data: formatDriver(updatedDriver) });
});

exports.updateAvailability = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const body = req.body;
    const data = {};

    if (body.timeZone !== undefined) data.availabilityTimeZone = body.timeZone;
    if (body.notes !== undefined) data.availabilityNotes = body.notes;
    if (body.submittedApplication !== undefined) data.submittedApplication = body.submittedApplication;

    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    if (body.weeklySchedule) {
        for (const day of days) {
            const schedule = body.weeklySchedule[day];
            if (!schedule) continue;
            if (schedule.enabled !== undefined) data[`${day}Enabled`] = schedule.enabled;
            if (schedule.startTime !== undefined) data[`${day}Start`] = schedule.startTime;
            if (schedule.endTime !== undefined) data[`${day}End`] = schedule.endTime;
        }
    }

    const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
    return sendSuccess(res, 200, { message: 'Availability updated', data: formatDriver(updatedDriver) });
});

exports.updateOnboardingFields = asyncHandler(async (req, res) => {
    const { error, user, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const body = req.body || {};
    const driverData = {};
    const userData = {};

    const companyInfo = body.companyInformation || {};
    const companyAddress = body.companyAddress || companyInfo.companyAddress;
    const companyName = body.companyName !== undefined ? body.companyName : companyInfo.companyName;
    const companyType = body.companyType !== undefined ? body.companyType : companyInfo.companyType;
    const taxIdentificationNumber = body.taxIdentificationNumber !== undefined
        ? body.taxIdentificationNumber
        : companyInfo.taxIdentificationNumber;
    const businessRegistrationNumber = body.businessRegistrationNumber !== undefined
        ? body.businessRegistrationNumber
        : companyInfo.businessRegistrationNumber;

    if (companyName !== undefined) { driverData.companyName = companyName; userData.companyName = companyName; }
    if (companyType !== undefined) driverData.companyType = companyType;
    if (taxIdentificationNumber !== undefined) driverData.taxIdentificationNumber = taxIdentificationNumber;
    if (businessRegistrationNumber !== undefined) driverData.businessRegistrationNumber = businessRegistrationNumber;
    if (companyAddress) {
        if (companyAddress.country !== undefined) driverData.companyCountry = companyAddress.country;
        if (companyAddress.city !== undefined) driverData.companyCity = companyAddress.city;
        if (companyAddress.street !== undefined) driverData.companyStreet = companyAddress.street;
        if (companyAddress.postalCode !== undefined) driverData.companyPostalCode = companyAddress.postalCode;
        if (companyAddress.state !== undefined) driverData.companyState = companyAddress.state;
    }

    const fleet = body.fleetInformation || {};
    if (body.priorLimoExperience !== undefined) driverData.priorLimoExperience = body.priorLimoExperience;
    else if (fleet.priorLimoExperience !== undefined) driverData.priorLimoExperience = fleet.priorLimoExperience;
    if (body.electricVehicleFleet !== undefined) driverData.electricVehicleFleet = body.electricVehicleFleet;
    else if (fleet.electricVehicleFleet !== undefined) driverData.electricVehicleFleet = fleet.electricVehicleFleet;
    if (body.femaleChauffeurs !== undefined) driverData.femaleChauffeurs = body.femaleChauffeurs;
    else if (fleet.femaleChauffeurs !== undefined) driverData.femaleChauffeurs = fleet.femaleChauffeurs;
    if (body.numberOfChauffeurs !== undefined) driverData.numberOfChauffeurs = body.numberOfChauffeurs;
    else if (fleet.numberOfChauffeurs !== undefined) driverData.numberOfChauffeurs = fleet.numberOfChauffeurs;
    if (body.numberOfFirstClassVehicles !== undefined) driverData.numberOfFirstClassVehicles = body.numberOfFirstClassVehicles;
    else if (fleet.numberOfFirstClassVehicles !== undefined) driverData.numberOfFirstClassVehicles = fleet.numberOfFirstClassVehicles;
    if (body.numberOfBusinessClassVans !== undefined) driverData.numberOfBusinessClassVans = body.numberOfBusinessClassVans;
    else if (fleet.numberOfBusinessClassVans !== undefined) driverData.numberOfBusinessClassVans = fleet.numberOfBusinessClassVans;
    if (body.businessClassVansDescription !== undefined) driverData.businessClassVansDescription = body.businessClassVansDescription;
    else if (fleet.businessClassVansDescription !== undefined) driverData.businessClassVansDescription = fleet.businessClassVansDescription;

    const chauffeur = body.firstChauffeurInformation || {};
    if (body.useAuthorizedRepresentativeDetails !== undefined) driverData.useAuthorizedRepresentativeDetails = body.useAuthorizedRepresentativeDetails;
    else if (chauffeur.useAuthorizedRepresentativeDetails !== undefined) driverData.useAuthorizedRepresentativeDetails = chauffeur.useAuthorizedRepresentativeDetails;
    if (body.firstName !== undefined) driverData.chauffeurFirstName = body.firstName;
    else if (chauffeur.firstName !== undefined) driverData.chauffeurFirstName = chauffeur.firstName;
    if (body.lastName !== undefined) driverData.chauffeurLastName = body.lastName;
    else if (chauffeur.lastName !== undefined) driverData.chauffeurLastName = chauffeur.lastName;
    if (body.email !== undefined) driverData.chauffeurEmail = body.email;
    else if (chauffeur.email !== undefined) driverData.chauffeurEmail = chauffeur.email;
    if (body.phone !== undefined) driverData.chauffeurPhone = body.phone;
    else if (chauffeur.phone !== undefined) driverData.chauffeurPhone = chauffeur.phone;
    if (body.driverLicenseId !== undefined) driverData.chauffeurDriverLicenseId = body.driverLicenseId;
    else if (chauffeur.driverLicenseId !== undefined) driverData.chauffeurDriverLicenseId = chauffeur.driverLicenseId;

    const vehicle = body.firstVehicleInformation || {};
    if (body.yearOfManufacture !== undefined) driverData.vehicleYearOfManufacture = body.yearOfManufacture;
    else if (vehicle.yearOfManufacture !== undefined) driverData.vehicleYearOfManufacture = vehicle.yearOfManufacture;
    if (body.brandAndModel !== undefined) driverData.vehicleBrandAndModel = body.brandAndModel;
    else if (vehicle.brandAndModel !== undefined) driverData.vehicleBrandAndModel = vehicle.brandAndModel;
    if (body.vehicleClass !== undefined) driverData.vehicleClass = body.vehicleClass;
    else if (vehicle.vehicleClass !== undefined) driverData.vehicleClass = vehicle.vehicleClass;
    if (body.color !== undefined) driverData.vehicleColor = body.color;
    else if (vehicle.color !== undefined) driverData.vehicleColor = vehicle.color;
    if (body.passengerCapacity !== undefined) driverData.vehiclePassengerCapacity = body.passengerCapacity;
    else if (vehicle.passengerCapacity !== undefined) driverData.vehiclePassengerCapacity = vehicle.passengerCapacity;
    if (body.luggageCapacity !== undefined) driverData.vehicleLuggageCapacity = body.luggageCapacity;
    else if (vehicle.luggageCapacity !== undefined) driverData.vehicleLuggageCapacity = vehicle.luggageCapacity;
    if (body.wifi !== undefined) driverData.vehicleWifi = body.wifi;
    else if (vehicle.wifi !== undefined) driverData.vehicleWifi = vehicle.wifi;
    if (body.vehicleNumberPlate !== undefined) driverData.vehicleNumberPlate = body.vehicleNumberPlate;
    else if (vehicle.vehicleNumberPlate !== undefined) driverData.vehicleNumberPlate = vehicle.vehicleNumberPlate;
    if (body.vehicleVIN !== undefined) driverData.vehicleVIN = body.vehicleVIN;
    else if (vehicle.vehicleVIN !== undefined) driverData.vehicleVIN = vehicle.vehicleVIN;

    if (
        body.requiredDocuments !== undefined
        || body.partnerTraining !== undefined
        || body.contractAgreement !== undefined
        || body.signed !== undefined
        || body.confirmationAgreement !== undefined
        || body.place !== undefined
        || body.availability !== undefined
        || body.timeZone !== undefined
        || body.notes !== undefined
        || body.submittedApplication !== undefined
        || body.weeklySchedule !== undefined
    ) {
        return sendError(res, 400, 'requiredDocuments, partnerTraining, contractAgreement, and availability are not supported on this endpoint');
    }

    const ops = [];

    if (Object.keys(userData).length > 0) {
        ops.push(prisma.user.update({ where: { id: user.id }, data: userData }));
    }

    if (Object.keys(driverData).length > 0) {
        ops.push(prisma.driver.update({ where: { id: driver.id }, data: driverData, include: driverInclude }));
    }

    if (ops.length === 0) {
        return sendError(res, 400, 'No onboarding fields provided');
    }

    const results = await prisma.$transaction(ops);
    const updatedDriver = results.find((result) => result && result.id === driver.id)
        || await prisma.driver.findUnique({ where: { id: driver.id }, include: driverInclude });

    return sendSuccess(res, 200, { message: 'Onboarding updated', data: formatDriver(updatedDriver) });
});

// ─── SUBMIT ONBOARDING ────────────────────────────────────────────────────────
// When a driver submits their onboarding, set isVerified = false (pending admin review).
// Previously accounts were auto-verified; now admin must explicitly approve.
exports.submitOnboarding = asyncHandler(async (req, res) => {
    const { error, user, driver } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const [updatedDriver] = await Promise.all([
        prisma.driver.update({
            where: { id: driver.id },
            data: { submittedApplication: true, submittedAt: new Date() },
            include: driverInclude,
        }),
        prisma.user.update({
            where: { id: user.id },
            data: {
                onboardingCompleted: true,
                // Set to false (pending) so admin must review before driver can operate
                isVerified: false,
            },
        }),
    ]);

    return sendSuccess(res, 200, {
        message: 'Partner onboarding submitted successfully. Your application is under review.',
        data: formatDriver(updatedDriver),
    });
});

// ─── ADMIN: VERIFY DRIVER ─────────────────────────────────────────────────────
// Admin-only endpoint to verify or unverify a driver after reviewing their documents.
// Route example: PATCH /api/admin/drivers/:driverId/verify
// Middleware must ensure req.user.role === 'admin' before reaching this handler.
exports.adminVerifyDriver = asyncHandler(async (req, res) => {
    const { driverId } = req.params;
    // isVerified = true to approve, false to revoke
    const { isVerified, reason } = req.body;

    if (typeof isVerified !== 'boolean') {
        return sendError(res, 400, 'isVerified (boolean) is required');
    }

    // Find the driver record
    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        include: { ...driverInclude },
    });

    if (!driver) {
        return sendError(res, 404, 'Driver not found');
    }

    // Update the user's isVerified flag
    const updatedUser = await prisma.user.update({
        where: { id: driver.userId },
        data: { isVerified },
    });

    // Send a notification to the driver
    await createNotificationRecord({
        recipientRole: 'driver',
        recipientUserId: driver.userId,
        title: isVerified ? 'Account Verified' : 'Account Verification Revoked',
        message: isVerified
            ? 'Congratulations! Your account has been verified by the admin. You can now accept ride assignments.'
            : `Your account verification has been revoked. Reason: ${reason || 'No reason provided.'}`,
        type: isVerified ? 'account_verified' : 'account_unverified',
        meta: { driverId: driver.id, isVerified, reason: reason || null },
    });

    return sendSuccess(res, 200, {
        message: isVerified
            ? 'Driver account verified successfully'
            : 'Driver account verification revoked',
        data: {
            driverId: driver.id,
            userId: driver.userId,
            isVerified: updatedUser.isVerified,
        },
    });
});

// ─── ADMIN: GET DRIVER BY ID ──────────────────────────────────────────────────
// Admin endpoint to fetch a single driver's full profile for review.
// Route example: GET /api/admin/drivers/:driverId
exports.adminGetDriverById = asyncHandler(async (req, res) => {
    const { driverId } = req.params;

    const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        include: {
            ...driverInclude,
            user: true,
        },
    });

    if (!driver) {
        return sendError(res, 404, 'Driver not found');
    }

    return sendSuccess(res, 200, {
        data: {
            ...formatDriver(driver),
            user: driver.user,
        },
    });
});

// ─── RIDE HANDLERS (unchanged) ────────────────────────────────────────────────

exports.getDriverRides = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const skip = (page - 1) * limit;

    const tab = req.query.tab || 'upcoming';
    const scope = req.query.scope || 'all';

    let where = {
        ...buildRideFilter(tab),
        assignedDriverId: req.user.id,
    };

    if (req.query.rideStatus) {
        where.rideStatus = req.query.rideStatus;
    }
    if (req.query.search && req.query.search.trim()) {
        const search = req.query.search.trim();
        where = {
            AND: [
                where,
                {
                    OR: [
                        { confNumber: { contains: search, mode: 'insensitive' } },
                        { pickupLocation: { contains: search, mode: 'insensitive' } },
                        { dropoffLocation: { contains: search, mode: 'insensitive' } },
                    ],
                },
            ],
        };
    }

    const orderBy = tab === 'past'
        ? [{ date: 'desc' }, { createdAt: 'desc' }]
        : [{ date: 'asc' }, { createdAt: 'desc' }];

    const [rides, total] = await Promise.all([
        prisma.booking.findMany({ where, include: rideInclude, orderBy, skip, take: limit }),
        prisma.booking.count({ where }),
    ]);

    return sendSuccess(res, 200, {
        tab,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        data: rides.map(mapRideForDriver),
    });
});

exports.getDriverRideById = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });
    if (!ride) return sendError(res, 404, 'Ride not found');

    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only view rides assigned to you');
    }

    return sendSuccess(res, 200, { data: mapRideForDriver(ride) });
});

exports.getDriverRideDetails = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });
    if (!ride) return sendError(res, 404, 'Ride not found');

    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only view rides assigned to you');
    }
    return sendSuccess(res, 200, { data: mapRideDetailsForDriver(ride) });
});

exports.updateMyRideStatus = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const { rideStatus } = req.body;
    const allowedStatuses = ['upcoming', 'confirmed', 'ongoing', 'completed', 'cancelled'];

    if (!allowedStatuses.includes(rideStatus)) {
        return sendError(res, 400, 'Invalid rideStatus value');
    }

    const ride = await prisma.booking.findUnique({ where: { id } });
    if (!ride) return sendError(res, 404, 'Ride not found');
    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only update rides assigned to you');
    }

    const updatedRide = await prisma.booking.update({
        where: { id },
        data: { rideStatus },
        include: rideInclude,
    });

    const io = req.app.get('io');
    if (io) {
        io.to(`ride_${id}`).emit('ride_status_updated', {
            rideId: id,
            status: rideStatus,
            ride: mapRideForDriver(updatedRide),
        });
    }

    if (ride.userId) {
        await createNotificationRecord({
            recipientRole: 'customer',
            recipientUserId: ride.userId,
            title: 'Ride status updated',
            message: `Your ride ${ride.confNumber || id} status changed to ${rideStatus}.`,
            type: 'ride_status_updated',
            meta: { rideId: id, status: rideStatus, driverId: req.user.id },
        });
    }

    // Transfer payment to driver only when ride is completed
    let payout = null;
    if (rideStatus === 'completed' && updatedRide.paymentStatus === 'paid') {
        payout = await transferDriverPayoutForBooking(id);
    }

    return sendSuccess(res, 200, { message: 'Ride status updated', data: mapRideForDriver(updatedRide), payout });
});

exports.confirmPickup = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const ride = await prisma.booking.findUnique({ where: { id } });
    if (!ride) return sendError(res, 404, 'Ride not found');
    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only confirm pickup for rides assigned to you');
    }
    if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
        return sendError(res, 400, `Cannot confirm pickup for a ${ride.rideStatus} ride`);
    }

    const updatedRide = await prisma.booking.update({
        where: { id },
        data: { rideStatus: 'ongoing' },
        include: rideInclude,
    });

    const io = req.app.get('io');
    if (io) {
        const payload = { rideId: id, status: 'ongoing', ride: mapRideForDriver(updatedRide) };
        io.to(`ride_${id}`).emit('ride_status_updated', payload);
        io.to('admin_panel').emit('ride_status_updated', payload);
    }

    if (ride.userId) {
        await createNotificationRecord({
            recipientRole: 'customer',
            recipientUserId: ride.userId,
            title: 'Pickup confirmed',
            message: `Pickup for your ride ${ride.confNumber || id} has been confirmed.`,
            type: 'pickup_confirmed',
            meta: { rideId: id, status: 'ongoing', driverId: req.user.id },
        });
    }

    return sendSuccess(res, 200, { message: 'Pickup confirmed successfully', data: mapRideForDriver(updatedRide) });
});

exports.cancelTrip = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const ride = await prisma.booking.findUnique({ where: { id } });
    if (!ride) return sendError(res, 404, 'Ride not found');
    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only cancel rides assigned to you');
    }
    if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
        return sendError(res, 400, `Cannot cancel a ${ride.rideStatus} ride`);
    }

    const updatedRide = await prisma.booking.update({
        where: { id },
        data: { rideStatus: 'cancelled' },
        include: rideInclude,
    });

    const io = req.app.get('io');
    if (io) {
        const payload = { rideId: id, status: 'cancelled', ride: mapRideForDriver(updatedRide) };
        io.to(`ride_${id}`).emit('ride_status_updated', payload);
        io.to('admin_panel').emit('ride_status_updated', payload);
    }

    if (ride.userId) {
        await createNotificationRecord({
            recipientRole: 'customer',
            recipientUserId: ride.userId,
            title: 'Ride cancelled by driver',
            message: `Your ride ${ride.confNumber || id} was cancelled by the driver.`,
            type: 'ride_cancelled',
            meta: { rideId: id, status: 'cancelled', cancelledBy: 'driver' },
        });
    }

    return sendSuccess(res, 200, { message: 'Trip cancelled successfully', data: mapRideForDriver(updatedRide) });
});

exports.uploadOnboardingFile = asyncHandler(async (req, res) => {
    if (!req.file) {
        return sendError(res, 400, 'No file uploaded');
    }

    const { folder, docType } = req.body;
    const targetFolder = folder || 'driver_onboarding';


    const result = await uploadToCloudinary(req.file.buffer, targetFolder);

    return sendSuccess(res, 200, { url: result.secure_url, publicId: result.public_id });
});

exports.acceptAssignedRide = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });

    if (!ride) return sendError(res, 404, 'Ride not found');
    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only accept rides assigned to you');
    }
    if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
        return sendError(res, 400, `Cannot accept a ${ride.rideStatus} ride`);
    }

    const updatedRide = await prisma.booking.update({
        where: { id },
        data: { rideStatus: 'confirmed' },
        include: rideInclude,
    });

    const io = req.app.get('io');
    if (io) {
        const payload = { rideId: id, status: 'confirmed', ride: mapRideForDriver(updatedRide) };
        io.to(`ride_${id}`).emit('ride_status_updated', payload);
        io.to('admin_panel').emit('ride_accepted_by_driver', payload);
    }

    if (ride.userId) {
        await createNotificationRecord({
            recipientRole: 'customer',
            recipientUserId: ride.userId,
            title: 'Ride confirmed',
            message: `Your ride ${ride.confNumber || id} has been accepted by the driver.`,
            type: 'ride_confirmed',
            meta: { rideId: id, status: 'confirmed', driverId: req.user.id },
        });
    }

    return sendSuccess(res, 200, { message: 'Ride accepted successfully', data: mapRideForDriver(updatedRide) });
});

exports.declineAssignedRide = asyncHandler(async (req, res) => {
    const { error } = await getDriverForUser(req.user.id);
    if (error) return sendError(res, error.code, error.message);

    const { id } = req.params;
    const { reason } = req.body || {};

    const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });

    if (!ride) return sendError(res, 404, 'Ride not found');
    if (ride.assignedDriverId !== req.user.id) {
        return sendError(res, 403, 'You can only decline rides assigned to you');
    }
    if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
        return sendError(res, 400, `Cannot decline a ${ride.rideStatus} ride`);
    }

    const updatedRide = await prisma.booking.update({
        where: { id },
        data: { assignedDriverId: null, rideStatus: 'upcoming' },
        include: rideInclude,
    });

    const io = req.app.get('io');
    if (io) {
        const payload = { rideId: id, driverId: req.user.id, reason: reason || null, ride: mapRideForDriver(updatedRide) };
        io.to('admin_panel').emit('ride_declined_by_driver', payload);
    }

    await createNotificationRecord({
        recipientRole: 'driver',
        title: 'Ride declined by driver',
        message: `Ride ${ride.confNumber || id} was declined by the assigned driver.`,
        type: 'ride_declined',
        meta: { rideId: id, driverId: req.user.id, reason: reason || null },
    });

    return sendSuccess(res, 200, { message: 'Ride declined successfully', data: mapRideForDriver(updatedRide) });
});