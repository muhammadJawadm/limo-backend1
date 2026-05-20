'use strict';

const { prisma }     = require('../config/db');
const { allowedNotificationRoles, buildNotificationScopeWhere, isAllowedNotificationRole } =
    require('../utils/notificationHelpers');
const asyncHandler   = require('../utils/asyncHandler');
const { sendSuccess, sendError, requireAdminGuard } = require('../utils/apiResponse');

// ─── QUERY SHAPES ─────────────────────────────────────────────────────────────

const notificationInclude = {
    recipient: {
        select: {
            id:        true,
            firstName: true,
            lastName:  true,
            email:     true,
            phone:     true,
            role:      true,
        },
    },
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const formatNotification = (notification) => {
    if (!notification) return null;
    return {
        ...notification,
        recipient: notification.recipient || null,
    };
};

const validateNotificationPayload = async (payload) => {
    const { recipientRole } = payload;

    if (!isAllowedNotificationRole(recipientRole)) {
        return 'recipientRole must be driver or customer';
    }
    if (!payload.title || !payload.title.trim()) {
        return 'title is required';
    }
    if (!payload.message || !payload.message.trim()) {
        return 'message is required';
    }

    if (payload.recipientUserId) {
        const recipient = await prisma.user.findUnique({
            where:  { id: payload.recipientUserId },
            select: { id: true, role: true },
        });
        if (!recipient) {
            return 'recipientUserId not found';
        }
        if (recipient.role !== recipientRole) {
            return 'recipientUserId does not match recipientRole';
        }
    }

    return null;
};

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

exports.getDriverNotifications = asyncHandler(async (req, res) => {
    if (!req.user || req.user.role !== 'driver') {
        return sendError(res, 403, 'Forbidden: driver access required');
    }

    const where = buildNotificationScopeWhere('driver', req.user.id);
    const notifications = await prisma.notification.findMany({
        where,
        include: notificationInclude,
        orderBy: { createdAt: 'desc' },
    });

    return sendSuccess(res, 200, {
        role:  'driver',
        count: notifications.length,
        data:  notifications.map(formatNotification),
    });
});

exports.getCustomerNotifications = asyncHandler(async (req, res) => {
    if (!req.user || req.user.role !== 'customer') {
        return sendError(res, 403, 'Forbidden: customer access required');
    }

    const where = buildNotificationScopeWhere('customer', req.user.id);
    const notifications = await prisma.notification.findMany({
        where,
        include: notificationInclude,
        orderBy: { createdAt: 'desc' },
    });

    return sendSuccess(res, 200, {
        role:  'customer',
        count: notifications.length,
        data:  notifications.map(formatNotification),
    });
});

exports.createNotification = asyncHandler(async (req, res) => {
    // Security guard restored — only admins may create notifications
    if (!requireAdminGuard(req, res)) return;

    const payload = {
        recipientRole:   req.body.recipientRole,
        recipientUserId: req.body.recipientUserId || null,
        title:           req.body.title,
        message:         req.body.message,
        type:            req.body.type || 'general',
        isRead:          req.body.isRead === true,
    };

    const validationError = await validateNotificationPayload(payload);
    if (validationError) {
        return sendError(res, 400, validationError);
    }

    const notification = await prisma.notification.create({
        data:    payload,
        include: notificationInclude,
    });

    return sendSuccess(res, 201, { data: formatNotification(notification) });
});

exports.updateNotification = asyncHandler(async (req, res) => {
    if (!requireAdminGuard(req, res)) return;

    const { id } = req.params;
    const existing = await prisma.notification.findUnique({ where: { id } });
    if (!existing) {
        return sendError(res, 404, 'Notification not found');
    }

    const nextRecipientRole   = req.body.recipientRole   !== undefined ? req.body.recipientRole   : existing.recipientRole;
    const nextRecipientUserId = req.body.recipientUserId !== undefined ? req.body.recipientUserId : existing.recipientUserId;
    const nextTitle           = req.body.title           !== undefined ? req.body.title           : existing.title;
    const nextMessage         = req.body.message         !== undefined ? req.body.message         : existing.message;
    const nextType            = req.body.type            !== undefined ? req.body.type            : existing.type;
    const nextIsRead          = req.body.isRead          !== undefined ? req.body.isRead          : existing.isRead;

    if (!isAllowedNotificationRole(nextRecipientRole)) {
        return sendError(res, 400, 'recipientRole must be driver or customer');
    }

    const validationError = await validateNotificationPayload({
        recipientRole:   nextRecipientRole,
        recipientUserId: nextRecipientUserId,
        title:           nextTitle,
        message:         nextMessage,
    });
    if (validationError) {
        return sendError(res, 400, validationError);
    }

    const notification = await prisma.notification.update({
        where: { id },
        data: {
            recipientRole:   nextRecipientRole,
            recipientUserId: nextRecipientUserId,
            title:           nextTitle,
            message:         nextMessage,
            type:            nextType,
            isRead:          nextIsRead,
        },
        include: notificationInclude,
    });

    return sendSuccess(res, 200, { data: formatNotification(notification) });
});

exports.deleteNotification = asyncHandler(async (req, res) => {
    // Security guard restored — only admins may delete notifications
    if (!requireAdminGuard(req, res)) return;

    const { id } = req.params;
    const existing = await prisma.notification.findUnique({ where: { id } });
    if (!existing) {
        return sendError(res, 404, 'Notification not found');
    }

    await prisma.notification.delete({ where: { id } });

    return sendSuccess(res, 200, { message: 'Notification deleted' });
});

exports.allowedNotificationRoles = allowedNotificationRoles;