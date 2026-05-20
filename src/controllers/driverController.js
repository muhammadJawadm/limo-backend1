'use strict';

const { prisma }       = require('../config/db');
const { uploadToCloudinary } = require('../utils/cloudinaryUpload');
const { buildRideFilter }    = require('../utils/rideFilters');
const { createNotificationRecord } = require('../utils/notificationHelpers');
const { transferDriverPayoutForBooking } = require('./paymentController');
const asyncHandler     = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { TRAINING_DEFAULTS } = require('../utils/constants');

// ─── INCLUDE CONFIG ───────────────────────────────────────────────────────────
// Standard include for driver queries
const driverInclude = {
    trainingModules: { orderBy: { moduleNumber: 'asc' } },
    requiredDocuments: true,
    vehicles: true,
};

// Standard include for ride queries (driver perspective)
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

        // Accept date-only input like YYYY-MM-DD by converting to UTC midnight
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

// Get or auto-create a Driver record for the authenticated user
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

// Build nested response shape from flat Prisma driver record
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

// Re-nest flat driver columns back into the nested object shape the
// frontend expects (mirrors the original Mongoose toObject() output)
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
            smokingAllowed: driver.vehicleSmokingAllowed,
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

// Get specific onboarding step data (keyed by step name)
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

// Map a booking to the driver-facing ride list shape
const mapRideForDriver = (booking) => {
    const user = booking.user || {};
    const passengerName = booking.userId
        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
        : `${booking.passengerFirstName || ''} ${booking.passengerLastName || ''}`.trim();
    return {
        id: booking.id,
        confNumber: booking.confNumber || `CNF-${booking.id.slice(-6).toUpperCase()}`,
        rideStatus: booking.rideStatus || 'upcoming',
        type: booking.type,
        date: booking.date,
        time: booking.time,
        passenger: {
            name: passengerName || 'Guest Passenger',
            email: user.email || booking.passengerEmail || booking.bookerEmail || null,
            phone: user.phone || booking.passengerPhone || booking.bookerPhone || null,
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
        totalAmount: typeof booking.totalAmount === 'number' ? booking.totalAmount : (booking.tripPrice || 0) + (booking.tollCharges || 0) + (booking.childSeatsFee || 0) + (booking.otherFees || 0),
        assignedDriverId: booking.assignedDriverId || null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        chargesAndFees: {
            tripPrice: booking.tripPrice || 0,
            tollCharges: booking.tollCharges || 0,
            childSeatsFee: booking.childSeatsFee || 0,
            otherFees: booking.otherFees || 0,
            paymentStatus: booking.paymentStatus || null,
            paymentIntentId: booking.paymentIntentId || null,
            paymentMethodId: booking.paymentMethodId || null,
        },
    };
};

// Map a booking to the detailed driver-facing ride shape (matches frontend expected shape)
const mapRideDetailsForDriver = (booking) => {
    const user = booking.user || {};
    const passengerName = booking.userId
        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
        : `${booking.passengerFirstName || ''} ${booking.passengerLastName || ''}`.trim();

    return {
        id: booking.id,
        confNumber: booking.confNumber || `CNF-${booking.id.slice(-6).toUpperCase()}`,
        rideStatus: booking.rideStatus || 'upcoming',
        type: booking.type,
        date: booking.date,
        time: booking.time,
        passenger: {
            name: passengerName || 'Guest Passenger',
            email: user.email || booking.passengerEmail || booking.bookerEmail || null,
            phone: user.phone || booking.passengerPhone || booking.bookerPhone || null,
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
        totalAmount: typeof booking.totalAmount === 'number' ? booking.totalAmount : (booking.tripPrice || 0) + (booking.tollCharges || 0) + (booking.childSeatsFee || 0) + (booking.otherFees || 0),
        assignedDriverId: booking.assignedDriverId || null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
        chargesAndFees: {
            tripPrice: booking.tripPrice || 0,
            tollCharges: booking.tollCharges || 0,
            childSeatsFee: booking.childSeatsFee || 0,
            otherFees: booking.otherFees || 0,
            paymentStatus: booking.paymentStatus || null,
            paymentIntentId: booking.paymentIntentId || null,
            paymentMethodId: booking.paymentMethodId || null,
        },
    };
};

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

exports.getMyOnboarding = asyncHandler(async (req, res) => {
    const { error, driver } = await getDriverForUser(req.user.id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, data: formatDriver(driver) });
});

exports.getMyProfile = asyncHandler(async (req, res) => {
    const { error, user, driver } = await getDriverForUser(req.user.id);
    if (error) return res.status(error.code).json({ success: false, message: error.message });
    return res.status(200).json({
        success: true,
        data: {
            ...buildDriverProfileView(user, driver),
            onboarding: formatDriver(driver),
        },
    });
});


exports.updateMyPersonalInfo = asyncHandler(async (req, res) => {

        const { error, user } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const {
            firstName,
            lastName,
            email,
            phone,
            location,
        } = req.body || {};

        const userData = {};

        if (firstName !== undefined) userData.firstName = firstName;
        if (lastName !== undefined) userData.lastName = lastName;
        if (location !== undefined) userData.location = location;

        if (email !== undefined) {
            const normalizedEmail = String(email).toLowerCase();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(normalizedEmail)) {
                return res.status(400).json({ success: false, message: 'Invalid email format' });
            }
            if (normalizedEmail !== user.email) {
                const existingEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
                if (existingEmail) {
                    return res.status(400).json({ success: false, message: 'Email already in use' });
                }
            }
            userData.email = normalizedEmail;
        }

        if (phone !== undefined) {
            if (phone !== user.phone) {
                const existingPhone = await prisma.user.findUnique({ where: { phone } });
                if (existingPhone) {
                    return res.status(400).json({ success: false, message: 'Phone number already in use' });
                }
            }
            userData.phone = phone;
        }

        if (Object.keys(userData).length === 0) {
            return res.status(400).json({ success: false, message: 'No personal info fields provided' });
        }

        const updatedUser = await prisma.user.update({
            where: { id: user.id },
            data: userData,
        });

        return res.status(200).json({
            success: true,
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
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { step } = req.params;
        const data = getOnboardingStepData(driver, step);
        if (data === undefined) {
            return res.status(404).json({ success: false, message: 'Invalid onboarding step' });
        }
        return res.status(200).json({ success: true, step, data });
});

exports.updateCompanyInformation = asyncHandler(async (req, res) => {

        const { error, user, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const {
            companyName, companyType, companyAddress,
            taxIdentificationNumber, businessRegistrationNumber,
        } = req.body;

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

        return res.status(200).json({ success: true, message: 'Company information updated', data: formatDriver(updatedDriver) });
});

exports.updateFleetInformation = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

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
        return res.status(200).json({ success: true, message: 'Fleet information updated', data: formatDriver(updatedDriver) });
});

exports.updateFirstChauffeurInformation = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const body = req.body;
        const data = {};
        if (body.useAuthorizedRepresentativeDetails !== undefined) data.useAuthorizedRepresentativeDetails = body.useAuthorizedRepresentativeDetails;
        if (body.firstName !== undefined) data.chauffeurFirstName = body.firstName;
        if (body.lastName !== undefined) data.chauffeurLastName = body.lastName;
        if (body.email !== undefined) data.chauffeurEmail = body.email;
        if (body.phone !== undefined) data.chauffeurPhone = body.phone;
        if (body.driverLicenseId !== undefined) data.chauffeurDriverLicenseId = body.driverLicenseId;

        const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
        return res.status(200).json({ success: true, message: 'First chauffeur information updated', data: formatDriver(updatedDriver) });
});

exports.updateFirstVehicleInformation = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const body = req.body;
        const data = {};
        if (body.yearOfManufacture !== undefined) data.vehicleYearOfManufacture = body.yearOfManufacture;
        if (body.brandAndModel !== undefined) data.vehicleBrandAndModel = body.brandAndModel;
        if (body.vehicleClass !== undefined) data.vehicleClass = body.vehicleClass;
        if (body.color !== undefined) data.vehicleColor = body.color;
        if (body.passengerCapacity !== undefined) data.vehiclePassengerCapacity = body.passengerCapacity;
        if (body.luggageCapacity !== undefined) data.vehicleLuggageCapacity = body.luggageCapacity;
        if (body.wifi !== undefined) data.vehicleWifi = body.wifi;
        if (body.smokingAllowed !== undefined) data.vehicleSmokingAllowed = body.smokingAllowed;
        if (body.vehicleNumberPlate !== undefined) data.vehicleNumberPlate = body.vehicleNumberPlate;
        if (body.vehicleVIN !== undefined) data.vehicleVIN = body.vehicleVIN;

        const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
        return res.status(200).json({ success: true, message: 'First vehicle information updated', data: formatDriver(updatedDriver) });
});

exports.updateRequiredDocuments = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        // req.body contains flat doc fields matching DriverDocument columns
        const docData = req.body;

        // Upsert using the existing field-key helpers — avoids duplicating every column twice
        await prisma.driverDocument.upsert({
            where:  { driverId: driver.id },
            update: buildDocumentUpdateData(docData),
            create: { driverId: driver.id, ...buildDocumentCreateData(docData) },
        });

        const updatedDriver = await prisma.driver.findUnique({ where: { id: driver.id }, include: driverInclude });
        return res.status(200).json({ success: true, message: 'Required documents updated', data: formatDriver(updatedDriver) });
});

exports.updatePartnerTraining = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { modules } = req.body;
        if (!Array.isArray(modules)) {
            return res.status(400).json({ success: false, message: 'modules must be an array' });
        }

        const completedModules = modules.filter((m) => m.completed === true).length;
        const isComplete = modules.length > 0 && completedModules === modules.length;

        // Replace all training modules in a transaction
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
        return res.status(200).json({ success: true, message: 'Partner training updated', data: formatDriver(updatedDriver) });
});

exports.updateContractAgreement = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { signed, confirmationAgreement, place } = req.body;
        const data = {};
        if (signed !== undefined) data.contractSigned = signed;
        if (confirmationAgreement !== undefined) data.contractConfirmationAgreement = confirmationAgreement;
        if (place !== undefined) data.contractPlace = place;

        const updatedDriver = await prisma.driver.update({ where: { id: driver.id }, data, include: driverInclude });
        return res.status(200).json({ success: true, message: 'Contract agreement updated', data: formatDriver(updatedDriver) });
});

exports.updatePaymentInformation = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { stripeAccountId, stripeOnboarded } = req.body;

        if (stripeAccountId === undefined && stripeOnboarded === undefined) {
            return res.status(400).json({ success: false, message: 'stripeAccountId or stripeOnboarded is required' });
        }

        const data = {};
        if (stripeAccountId !== undefined) data.stripeAccountId = stripeAccountId;
        if (stripeOnboarded !== undefined) data.stripeOnboarded = stripeOnboarded;

        const updatedDriver = await prisma.driver.update({
            where: { id: driver.id },
            data,
            include: driverInclude,
        });
        return res.status(200).json({ success: true, message: 'Stripe payment status updated', data: formatDriver(updatedDriver) });
});

exports.updateAvailability = asyncHandler(async (req, res) => {

        const { error, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const body = req.body;
        const data = {};

        if (body.timeZone !== undefined) data.availabilityTimeZone = body.timeZone;
        if (body.notes !== undefined) data.availabilityNotes = body.notes;
        if (body.submittedApplication !== undefined) data.submittedApplication = body.submittedApplication;

        // Map weeklySchedule nested object → flat columns
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
        return res.status(200).json({ success: true, message: 'Availability updated', data: formatDriver(updatedDriver) });
});

exports.updateOnboardingFields = asyncHandler(async (req, res) => {

        const { error, user, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

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
        if (body.smokingAllowed !== undefined) driverData.vehicleSmokingAllowed = body.smokingAllowed;
        else if (vehicle.smokingAllowed !== undefined) driverData.vehicleSmokingAllowed = vehicle.smokingAllowed;
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
            return res.status(400).json({
                success: false,
                message: 'requiredDocuments, partnerTraining, contractAgreement, and availability are not supported on this endpoint',
            });
        }

        const ops = [];

        if (Object.keys(userData).length > 0) {
            ops.push(prisma.user.update({ where: { id: user.id }, data: userData }));
        }

        if (Object.keys(driverData).length > 0) {
            ops.push(prisma.driver.update({ where: { id: driver.id }, data: driverData, include: driverInclude }));
        }

        if (ops.length === 0) {
            return res.status(400).json({ success: false, message: 'No onboarding fields provided' });
        }

        const results = await prisma.$transaction(ops);
        const updatedDriver = results.find((result) => result && result.id === driver.id)
            || await prisma.driver.findUnique({ where: { id: driver.id }, include: driverInclude });

        return res.status(200).json({
            success: true,
            message: 'Onboarding updated',
            data: formatDriver(updatedDriver),
        });
});

exports.submitOnboarding = asyncHandler(async (req, res) => {

        const { error, user, driver } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const [updatedDriver] = await Promise.all([
            prisma.driver.update({
                where: { id: driver.id },
                data: { submittedApplication: true, submittedAt: new Date() },
                include: driverInclude,
            }),
            prisma.user.update({ where: { id: user.id }, data: { onboardingCompleted: true } }),
        ]);

        return res.status(200).json({
            success: true,
            message: 'Partner onboarding submitted successfully',
            data: formatDriver(updatedDriver),
        });
});

exports.getDriverRides = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
        const skip = (page - 1) * limit;

        const tab = req.query.tab || 'upcoming';
        const scope = req.query.scope || 'all';

        // buildRideFilter must return Prisma where-compatible object
        let where = { ...buildRideFilter(tab) };

        if (scope === 'mine') where.assignedDriverId = req.user.id;
        if (scope === 'unassigned') where.assignedDriverId = null;
        if (req.query.rideStatus) where.rideStatus = req.query.rideStatus;

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

        return res.status(200).json({
            success: true,
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
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

        const isAssignedToMe = ride.assignedDriverId === req.user.id;
        if (ride.assignedDriverId && !isAssignedToMe) {
            return res.status(403).json({ success: false, message: 'Forbidden: You can only view details for rides assigned to you or unassigned rides' });
        }

        return res.status(200).json({ success: true, data: mapRideForDriver(ride) });
});

exports.getDriverRideDetails = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const ride = await prisma.booking.findUnique({ where: { id }, include: rideInclude });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

        const isAssignedToMe = ride.assignedDriverId === req.user.id;
        if (ride.assignedDriverId && !isAssignedToMe) {
            return res.status(403).json({ success: false, message: 'You can only view details for rides assigned to you or unassigned rides' });
        }

        return res.status(200).json({ success: true, data: mapRideDetailsForDriver(ride) });
});

exports.assignRideToMe = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const ride = await prisma.booking.findUnique({ where: { id } });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });

        if (ride.assignedDriverId && ride.assignedDriverId !== req.user.id) {
            return res.status(409).json({ success: false, message: 'Ride is already assigned to another driver' });
        }

        const updateData = { assignedDriverId: req.user.id };
        if (ride.rideStatus === 'upcoming') updateData.rideStatus = 'confirmed';

        const updatedRide = await prisma.booking.update({
            where: { id },
            data: updateData,
            include: rideInclude,
        });

        let payout = { transferred: false, reason: 'booking_not_paid' };
        if (updatedRide.paymentStatus === 'paid') {
            payout = await transferDriverPayoutForBooking(updatedRide.id);
        }

        const io = req.app.get('io');
        if (io) {
            io.to(`driver_${req.user.id}`).to('admin_panel').emit('ride_assigned', {
                rideId: id,
                driverId: req.user.id,
                ride: mapRideForDriver(updatedRide),
            });
        }

        if (ride.userId) {
            await createNotificationRecord({
                recipientRole: 'customer',
                recipientUserId: ride.userId,
                title: 'Ride assigned',
                message: `Your ride ${ride.confNumber || id} has been assigned to a driver.`,
                type: 'ride_assigned',
            });
        }

        return res.status(200).json({ success: true, message: 'Ride assigned successfully', data: mapRideForDriver(updatedRide), payout });
});

exports.updateMyRideStatus = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const { rideStatus } = req.body;
        const allowedStatuses = ['upcoming', 'confirmed', 'ongoing', 'completed', 'cancelled'];

        if (!allowedStatuses.includes(rideStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid rideStatus value' });
        }

        const ride = await prisma.booking.findUnique({ where: { id } });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
        if (ride.assignedDriverId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'You can only update rides assigned to you' });
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
            });
        }

        return res.status(200).json({ success: true, message: 'Ride status updated', data: mapRideForDriver(updatedRide) });
});

exports.confirmPickup = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const ride = await prisma.booking.findUnique({ where: { id } });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
        if (ride.assignedDriverId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'You can only confirm pickup for rides assigned to you' });
        }
        if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
            return res.status(400).json({ success: false, message: `Cannot confirm pickup for a ${ride.rideStatus} ride` });
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
            });
        }

        return res.status(200).json({ success: true, message: 'Pickup confirmed successfully', data: mapRideForDriver(updatedRide) });
});

exports.cancelTrip = asyncHandler(async (req, res) => {

        const { error } = await getDriverForUser(req.user.id);
        if (error) return res.status(error.code).json({ success: false, message: error.message });

        const { id } = req.params;
        const ride = await prisma.booking.findUnique({ where: { id } });
        if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
        if (ride.assignedDriverId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'You can only cancel rides assigned to you' });
        }
        if (ride.rideStatus === 'completed' || ride.rideStatus === 'cancelled') {
            return res.status(400).json({ success: false, message: `Cannot cancel a ${ride.rideStatus} ride` });
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
            });
        }

        return res.status(200).json({ success: true, message: 'Trip cancelled successfully', data: mapRideForDriver(updatedRide) });
});

exports.uploadOnboardingFile = asyncHandler(async (req, res) => {

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { folder, docType } = req.body;
        const targetFolder = folder || 'driver_onboarding';

        if (docType) console.log(`Uploading ${docType} for driver ${req.user.id}`);

        const result = await uploadToCloudinary(req.file.buffer, targetFolder);

        return res.status(200).json({
            success: true,
            url: result.secure_url,
            publicId: result.public_id,
        });
});
