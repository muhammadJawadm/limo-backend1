'use strict';

const { prisma } = require('../config/db');

// ─────────────────────────────────────────────────────────────
// GET MESSAGE HISTORY
// GET /api/chat/messages/:rideId
// ─────────────────────────────────────────────────────────────
exports.getRideMessages = async (req, res) => {
    try {
        const { rideId } = req.params;

        const messages = await prisma.message.findMany({
            where: { bookingId: rideId },
            orderBy: { createdAt: 'asc' },
            take: 100,
            include: {
                sender: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        role: true,
                    },
                },
            },
        });

        return res.status(200).json({
            success: true,
            data: messages,
        });
    } catch (error) {
        console.error('getRideMessages error:', error);
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};