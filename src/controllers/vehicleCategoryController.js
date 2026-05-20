'use strict';

const { prisma }     = require('../config/db');
const { uploadToCloudinary } = require('../utils/cloudinaryUpload');
const asyncHandler   = require('../utils/asyncHandler');
const { sendSuccess, sendError, requireAdminGuard } = require('../utils/apiResponse');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Validates capacity fields, accepting both a nested `capacity` object and flat
 * top-level `luggageCapacity` / `passengerCapacity` properties.
 */
const validateCapacityFields = (capacity, bodyLuggage, bodyPassengers) => {
    const luggageCapacity   = capacity?.luggage   ?? bodyLuggage;
    const passengerCapacity = capacity?.passengers ?? bodyPassengers;

    if (!Number.isInteger(luggageCapacity) || luggageCapacity < 0) {
        return { valid: false, message: 'luggageCapacity must be a non-negative integer' };
    }
    if (!Number.isInteger(passengerCapacity) || passengerCapacity < 0) {
        return { valid: false, message: 'passengerCapacity must be a non-negative integer' };
    }

    return { valid: true, luggageCapacity, passengerCapacity };
};

// ─── CREATE ───────────────────────────────────────────────────────────────────

exports.createVehicleCategory = asyncHandler(async (req, res) => {
    //  if (!requireAdminGuard(req, res, 'Forbidden: Only admins can modify vehicle categories')) return;

    const { name, type, classification, capacity, baseFare, perMileRate30, perMileRate40, perHour, picture } = req.body;

    if (!name || !type || !classification) {
        return sendError(res, 400, 'name, type, and classification are required');
    }

    const capacityValidation = validateCapacityFields(
        capacity,
        req.body.luggageCapacity,
        req.body.passengerCapacity,
    );
    if (!capacityValidation.valid) {
        return sendError(res, 400, capacityValidation.message);
    }

    if (baseFare === undefined || baseFare === null) {
        return sendError(res, 400, 'baseFare is required');
    }
    if (perMileRate30 === undefined || perMileRate30 === null) {
        return sendError(res, 400, 'perMileRate30 is required');
    }
    if (perMileRate40 === undefined || perMileRate40 === null) {
        return sendError(res, 400, 'perMileRate40 is required');
    }
    if (perHour === undefined || perHour === null) {
        return sendError(res, 400, 'perHour is required');
    }

    let pictureUrl = picture;
    if (req.file) {
        const uploadResult = await uploadToCloudinary(req.file.buffer, 'vehicle_categories');
        pictureUrl = uploadResult.secure_url;
    }

    if (!pictureUrl) {
        return sendError(res, 400, 'picture is required (either as file upload or URL string)');
    }

    const category = await prisma.vehicleCategory.create({
        data: {
            name,
            type,
            classification,
            luggageCapacity:   capacityValidation.luggageCapacity,
            passengerCapacity: capacityValidation.passengerCapacity,
            baseFare:          parseFloat(baseFare),
            perMileRate30:   parseFloat(perMileRate30),
            perMileRate40:   parseFloat(perMileRate40),
            perHour:           parseFloat(perHour),
            picture:           pictureUrl,
        },
    });

    return sendSuccess(res, 201, { data: category });
});

// ─── GET ALL (with optional filters) ─────────────────────────────────────────

exports.getVehicleCategories = asyncHandler(async (req, res) => {
    const { classification, type, name } = req.query;

    const where = {};
    if (classification) where.classification = classification;
    if (type)           where.type           = { equals: type, mode: 'insensitive' };
    if (name)           where.name           = { contains: name, mode: 'insensitive' };

    const categories = await prisma.vehicleCategory.findMany({
        where,
        orderBy: { name: 'asc' },
    });

    return sendSuccess(res, 200, { count: categories.length, data: categories });
});

// ─── GET BY ID ────────────────────────────────────────────────────────────────

exports.getVehicleCategoryById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const category = await prisma.vehicleCategory.findUnique({ where: { id } });
    if (!category) {
        return sendError(res, 404, 'Vehicle category not found');
    }

    return sendSuccess(res, 200, { data: category });
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────

exports.updateVehicleCategory = asyncHandler(async (req, res) => {
    // Security guard restored — only admins may update vehicle categories
    // if (!requireAdminGuard(req, res, 'Forbidden: Only admins can modify vehicle categories')) return;

    const { id } = req.params;
    const { name, type, classification, capacity, baseFare, perMileRate30, perMileRate40, perHour, picture } = req.body;

    const data = {};
    if (name           !== undefined) data.name           = name;
    if (type           !== undefined) data.type           = type;
    if (classification !== undefined) data.classification = classification;
    if (baseFare       !== undefined) data.baseFare       = parseFloat(baseFare);
    if (perMileRate30  !== undefined) data.perMileRate30  = parseFloat(perMileRate30);
    if (perMileRate40  !== undefined) data.perMileRate40  = parseFloat(perMileRate40);
    if (perHour        !== undefined) data.perHour        = parseFloat(perHour);

    // Handle capacity fields with validation
    if (capacity || req.body.luggageCapacity !== undefined || req.body.passengerCapacity !== undefined) {
        const capacityValidation = validateCapacityFields(
            capacity,
            req.body.luggageCapacity,
            req.body.passengerCapacity,
        );
        if (!capacityValidation.valid) {
            return sendError(res, 400, capacityValidation.message);
        }
        data.luggageCapacity   = capacityValidation.luggageCapacity;
        data.passengerCapacity = capacityValidation.passengerCapacity;
    }

    if (req.file) {
        const uploadResult = await uploadToCloudinary(req.file.buffer, 'vehicle_categories');
        data.picture = uploadResult.secure_url;
    } else if (picture !== undefined) {
        data.picture = picture;
    }

    const category = await prisma.vehicleCategory.update({ where: { id }, data });

    return sendSuccess(res, 200, { message: 'Vehicle category updated', data: category });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

exports.deleteVehicleCategory = asyncHandler(async (req, res) => {
    if (!requireAdminGuard(req, res, 'Forbidden: Only admins can modify vehicle categories')) return;

    const { id } = req.params;

    await prisma.vehicleCategory.delete({ where: { id } });

    return sendSuccess(res, 200, { message: 'Vehicle category deleted' });
});
