'use strict';

const { prisma }     = require('../config/db');
const asyncHandler   = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { validateSupportRequest } = require('../utils/validators');

// ─── QUERY SHAPES ─────────────────────────────────────────────────────────────

const supportRequestSelect = {
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

exports.createSupportRequest = asyncHandler(async (req, res) => {
    const payload = {
        firstName:   req.body.firstName,
        lastName:    req.body.lastName,
        email:       req.body.email,
        phone:       req.body.phone,
        description: req.body.description,
    };

    const validationError = validateSupportRequest(payload);
    if (validationError) {
        return sendError(res, 400, validationError);
    }

    const supportRequest = await prisma.supportRequest.create({
        data: {
            firstName:   payload.firstName.trim(),
            lastName:    payload.lastName.trim(),
            email:       payload.email.trim().toLowerCase(),
            phone:       payload.phone.trim(),
            description: payload.description.trim(),
        },
        select: supportRequestSelect,
    });

    return sendSuccess(res, 201, { data: supportRequest });
});

exports.getSupportRequestById = asyncHandler(async (req, res) => {
    const supportRequest = await prisma.supportRequest.findUnique({
        where:  { id: req.params.id },
        select: supportRequestSelect,
    });

    if (!supportRequest) {
        return sendError(res, 404, 'Support request not found');
    }

    return sendSuccess(res, 200, { data: supportRequest });
});

exports.getAllSupportRequests = asyncHandler(async (req, res) => {
    const supportRequests = await prisma.supportRequest.findMany({
        orderBy: { createdAt: 'desc' },
        select:  supportRequestSelect,
    });

    return sendSuccess(res, 200, { count: supportRequests.length, data: supportRequests });
});

exports.markSupportRequestAsRead = asyncHandler(async (req, res) => {
    const existing = await prisma.supportRequest.findUnique({
        where:  { id: req.params.id },
        select: { id: true },
    });

    if (!existing) {
        return sendError(res, 404, 'Support request not found');
    }

    const supportRequest = await prisma.supportRequest.update({
        where:  { id: req.params.id },
        data:   { isRead: true },
        select: supportRequestSelect,
    });

    return sendSuccess(res, 200, { data: supportRequest });
});