'use strict';

const { prisma }     = require('../config/db');
const sendEmail      = require('../utils/sendEmail');
const asyncHandler   = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');

// ─── QUERY SHAPES ─────────────────────────────────────────────────────────────

const adminUserSelect = {
    id:                  true,
    firstName:           true,
    lastName:            true,
    email:               true,
    phone:               true,
    location:            true,
    role:                true,
    companyName:         true,
    isVerified:          true,
    onboardingCompleted: true,
    createdAt:           true,
    updatedAt:           true,
    customerProfile: {
        select: {
            id:                   true,
            preferredVehicleClass: true,
            specialRequirements:  true,
            createdAt:            true,
            updatedAt:            true,
        },
    },
};

const adminDriverInclude = {
    user:              { select: adminUserSelect },
    requiredDocuments: true,
    vehicles:          { orderBy: { createdAt: 'desc' } },
};

const adminBookingInclude = {
    user:           { select: adminUserSelect },
    assignedDriver: { select: adminUserSelect },
    vehicleCategory: true,
    stopLocations:   true,
    messages: {
        orderBy: { createdAt: 'desc' },
        take:    20,
        include: {
            sender: {
                select: {
                    id:        true,
                    firstName: true,
                    lastName:  true,
                    email:     true,
                    phone:     true,
                    role:      true,
                },
            },
        },
    },
};

const adminNotificationInclude = {
    recipient: { select: adminUserSelect },
};

const adminSupportRequestSelect = {
    id:          true,
    firstName:   true,
    lastName:    true,
    email:       true,
    phone:       true,
    description: true,
    isRead:      true,
    createdAt:   true,
    updatedAt:   true,
};

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

exports.getAllUsers = asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        select:  adminUserSelect,
    });

    return sendSuccess(res, 200, { count: users.length, data: users });
});

exports.getAllDrivers = asyncHandler(async (req, res) => {
    const drivers = await prisma.driver.findMany({
        orderBy: { createdAt: 'desc' },
        include: adminDriverInclude,
    });

    return sendSuccess(res, 200, { count: drivers.length, data: drivers });
});

exports.getAllVehicleCategories = asyncHandler(async (req, res) => {
    const categories = await prisma.vehicleCategory.findMany({
        orderBy: { name: 'asc' },
    });

    return sendSuccess(res, 200, { count: categories.length, data: categories });
});

exports.getAllBookings = asyncHandler(async (req, res) => {
    const bookings = await prisma.booking.findMany({
        orderBy: { createdAt: 'desc' },
        include: adminBookingInclude,
    });

    return sendSuccess(res, 200, { count: bookings.length, data: bookings });
});

exports.getAllNotifications = asyncHandler(async (req, res) => {
    const notifications = await prisma.notification.findMany({
        orderBy: { createdAt: 'desc' },
        include: adminNotificationInclude,
    });

    return sendSuccess(res, 200, { count: notifications.length, data: notifications });
});

exports.getAllPayments = asyncHandler(async (req, res) => {
    // Payments are stored on bookings (flattened payment fields)
    const payments = await prisma.booking.findMany({
        where: {
            OR: [
                { paymentIntentId: { not: null } },
                { paymentStatus:   { not: 'pending' } },
            ],
        },
        orderBy: { createdAt: 'desc' },
        select: {
            id:               true,
            confNumber:       true,
            userId:           true,
            assignedDriverId: true,
            paymentStatus:    true,
            paymentIntentId:  true,
            totalAmount:      true,
            platformFee:      true,
            driverAmount:     true,
            createdAt:        true,
            updatedAt:        true,
            vehicleCategory:  true,
        },
    });

    return sendSuccess(res, 200, { count: payments.length, data: payments });
});

exports.getAllSupportRequests = asyncHandler(async (req, res) => {
    const supportRequests = await prisma.supportRequest.findMany({
        orderBy: { createdAt: 'desc' },
        select:  adminSupportRequestSelect,
    });

    return sendSuccess(res, 200, { count: supportRequests.length, data: supportRequests });
});

exports.sendAdminMail = asyncHandler(async (req, res) => {
    const { to, subject, message, html, text, from } = req.body;

    if (!to || !subject) {
        return sendError(res, 400, 'to and subject are required');
    }

    if (!message && !html && !text) {
        return sendError(res, 400, 'message, html, or text is required');
    }

    await sendEmail.sendEmailAdmin({
        to,
        subject,
        message,
        html,
        text,
        from,
    });

    return sendSuccess(res, 200, { message: 'Admin email sent successfully' });
});
