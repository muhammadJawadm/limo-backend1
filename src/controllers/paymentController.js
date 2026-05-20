'use strict';

const { prisma }     = require('../config/db');
const asyncHandler   = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Lazy Stripe initialisation — avoids crashing at startup if key is missing. */
const getStripe = () => {
    if (!process.env.STRIPE_SECRET_KEY) {
        throw new Error('STRIPE_SECRET_KEY environment variable is not set');
    }
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
};

const platformFeePercent = () =>
    parseFloat(process.env.STRIPE_PLATFORM_FEE_PERCENT) || 20;

const calculateSplitAmounts = (totalAmount) => {
    const feePercent  = platformFeePercent();
    const platformFee = (totalAmount * feePercent) / 100;
    const driverAmount = totalAmount - platformFee;
    return { platformFee, driverAmount, feePercent };
};

const normalizeEmail = (email) =>
    typeof email === 'string' ? email.trim().toLowerCase() : '';

const getGuestPaymentContact = (body) => ({
    email:
        body.email
        || body.guestEmail
        || body.bookerEmail
        || body.bookerDetails?.email
        || body.passengerDetails?.email
        || '',
    phone:
        body.phone
        || body.guestPhone
        || body.bookerPhone
        || body.bookerDetails?.phone
        || body.passengerDetails?.phone
        || '',
});

const canAccessBookingPayment = (booking, req) => {
    if (req.user && (req.user.role === 'admin' || booking.userId === req.user.id)) {
        return { allowed: true };
    }

    if (!booking) {
        return { allowed: false, status: 404, message: 'Booking not found' };
    }

    const contact = getGuestPaymentContact(req.body || {});
    const email   = normalizeEmail(contact.email);
    const phone   = typeof contact.phone === 'string' ? contact.phone.trim() : '';

    if (!email && !phone) {
        return {
            allowed: false,
            status:  400,
            message: 'email or phone is required to access guest payment',
        };
    }

    const allowedEmails = [booking.bookerEmail, booking.passengerEmail]
        .map(normalizeEmail)
        .filter(Boolean);
    const allowedPhones = [booking.bookerPhone, booking.passengerPhone]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean);

    const emailMatches = email && allowedEmails.includes(email);
    const phoneMatches = phone && allowedPhones.includes(phone);

    if (!emailMatches && !phoneMatches) {
        return {
            allowed: false,
            status:  403,
            message: 'Forbidden: guest contact details do not match this booking',
        };
    }

    return { allowed: true };
};

// ─── DRIVER PAYOUT (internal) ─────────────────────────────────────────────────

const transferDriverPayoutForBooking = async (bookingId) => {
    const stripe  = getStripe();
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });

    if (!booking)                      return { transferred: false, reason: 'booking_not_found' };
    if (booking.paymentStatus !== 'paid') return { transferred: false, reason: 'booking_not_paid' };
    if (!booking.assignedDriverId)     return { transferred: false, reason: 'driver_not_assigned' };
    if (!booking.paymentIntentId)      return { transferred: false, reason: 'missing_payment_intent' };

    const driver = await prisma.driver.findUnique({ where: { userId: booking.assignedDriverId } });
    if (!driver || !driver.stripeAccountId || !driver.stripeOnboarded) {
        return { transferred: false, reason: 'driver_not_ready' };
    }

    const totalAmount = booking.totalAmount || 0;
    if (totalAmount <= 0) return { transferred: false, reason: 'invalid_total_amount' };

    const { platformFee, driverAmount } = calculateSplitAmounts(totalAmount);
    if (driverAmount <= 0) return { transferred: false, reason: 'invalid_driver_amount' };

    const transferGroup    = `booking_${booking.id}`;
    const existingTransfers = await stripe.transfers.list({ transfer_group: transferGroup, limit: 10 });
    if (existingTransfers.data.length > 0) {
        return {
            transferred: false,
            reason:      'already_transferred',
            transferId:  existingTransfers.data[0].id,
        };
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(booking.paymentIntentId);
    const chargeId = typeof paymentIntent.latest_charge === 'string'
        ? paymentIntent.latest_charge
        : paymentIntent.latest_charge?.id;

    if (!chargeId) return { transferred: false, reason: 'missing_charge_for_transfer' };

    const transfer = await stripe.transfers.create(
        {
            amount:             Math.round(driverAmount * 100),
            currency:           'usd',
            destination:        driver.stripeAccountId,
            source_transaction: chargeId,
            transfer_group:     transferGroup,
            metadata: {
                bookingId:     booking.id,
                driverUserId:  booking.assignedDriverId,
            },
        },
        { idempotencyKey: `booking_${booking.id}_driver_payout` },
    );

    await prisma.booking.update({
        where: { id: booking.id },
        data:  { platformFee, driverAmount },
    });

    return { transferred: true, transferId: transfer.id };
};

// ─── DRIVER CONNECT (Stripe Express onboarding) ───────────────────────────────

const driverConnect = asyncHandler(async (req, res) => {
    const stripe = getStripe();

    // URLs resolved at request-time so FRONTEND_URL is guaranteed to be loaded
    const returnUrl  = `${process.env.FRONTEND_URL}/driver/onboarding?step=9`;
    const refreshUrl = `${process.env.FRONTEND_URL}/driver/onboarding?step=9`;

    const driver = await prisma.driver.findUnique({ where: { userId: req.user.id } });
    if (!driver) return sendError(res, 404, 'Driver not found');

    let accountId = driver.stripeAccountId;
    if (!accountId) {
        const account = await stripe.accounts.create({ type: 'express' });
        accountId = account.id;
        await prisma.driver.update({
            where: { id: driver.id },
            data:  { stripeAccountId: accountId },
        });
    }

    const accountLink = await stripe.accountLinks.create({
        account:     accountId,
        refresh_url: refreshUrl,
        return_url:  returnUrl,
        type:        'account_onboarding',
    });

    return sendSuccess(res, 200, { url: accountLink.url });
});

// ─── DRIVER CONNECT STATUS ────────────────────────────────────────────────────

const driverConnectStatus = asyncHandler(async (req, res) => {
    const stripe = getStripe();

    const driver = await prisma.driver.findUnique({ where: { userId: req.user.id } });
    if (!driver) return sendError(res, 404, 'Driver not found');

    if (!driver.stripeAccountId) {
        return sendSuccess(res, 200, { onboarded: false });
    }

    const account    = await stripe.accounts.retrieve(driver.stripeAccountId);
    const isOnboarded = account.details_submitted;

    if (driver.stripeOnboarded !== isOnboarded) {
        await prisma.driver.update({
            where: { id: driver.id },
            data:  { stripeOnboarded: isOnboarded },
        });
    }

    return sendSuccess(res, 200, { onboarded: isOnboarded });
});

// ─── CREATE PAYMENT INTENT ────────────────────────────────────────────────────

const createPaymentIntent = asyncHandler(async (req, res) => {
    const stripe      = getStripe();
    const { bookingId } = req.body;

    const booking = await prisma.booking.findUnique({
        where:   { id: bookingId },
        include: { assignedDriver: true },
    });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const access = canAccessBookingPayment(booking, req);
    if (!access.allowed) {
        return sendError(res, access.status, access.message);
    }

    const totalAmount = booking.totalAmount || 0;
    if (totalAmount <= 0) {
        return sendError(res, 400, 'Booking total amount must be greater than zero');
    }

    const { platformFee, driverAmount } = calculateSplitAmounts(totalAmount);

    const paymentIntent = await stripe.paymentIntents.create({
        amount:   Math.round(totalAmount * 100),
        currency: 'usd',
        metadata: { bookingId: booking.id },
    });

    await prisma.booking.update({
        where: { id: bookingId },
        data:  { platformFee, driverAmount, paymentIntentId: paymentIntent.id },
    });

    return sendSuccess(res, 200, { clientSecret: paymentIntent.client_secret });
});

// ─── CONFIRM PAYMENT ──────────────────────────────────────────────────────────

const confirmPayment = asyncHandler(async (req, res) => {
    const stripe = getStripe();
    const { bookingId, paymentIntentId } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const access = canAccessBookingPayment(booking, req);
    if (!access.allowed) {
        return sendError(res, access.status, access.message);
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
        // Extract charge and payment method details
        const charge = paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data[0];
        const paymentMethodId = paymentIntent.payment_method || null;
        const cardBrand = charge?.payment_method_details?.card?.brand || null;
        const chargeId = charge?.id || null;
        const receiptUrl = charge?.receipt_url || null;
        const paymentConfirmedAt = paymentIntent.created ? new Date(paymentIntent.created * 1000) : new Date();

        const updated = await prisma.booking.update({
            where: { id: bookingId },
            data:  {
                paymentStatus: 'paid',
                paymentIntentId,
                paymentMethodId,
                cardBrand,
                chargeId,
                receiptUrl,
                paymentConfirmedAt,
            },
        });

        let payout = { transferred: false, reason: 'driver_not_assigned' };
        if (updated.assignedDriverId) {
            payout = await transferDriverPayoutForBooking(updated.id);
        }

        return sendSuccess(res, 200, {
            message: 'Payment confirmed successfully',
            status:  updated.paymentStatus,
            payout,
        });
    }

    return sendError(res, 400, 'Payment not successful');
});

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────

const webhook = async (req, res) => {
    const stripe          = getStripe();
    const sig             = req.headers['stripe-signature'];
    const endpointSecret  = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook Error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'payment_intent.succeeded': {
                const pi = event.data.object;
                if (pi.metadata?.bookingId) {
                    const charge = pi.charges && pi.charges.data && pi.charges.data[0];
                    const paymentMethodId = pi.payment_method || null;
                    const cardBrand = charge?.payment_method_details?.card?.brand || null;
                    const chargeId = charge?.id || null;
                    const receiptUrl = charge?.receipt_url || null;
                    const paymentConfirmedAt = pi.created ? new Date(pi.created * 1000) : new Date();

                    const booking = await prisma.booking.update({
                        where: { id: pi.metadata.bookingId },
                        data:  {
                            paymentStatus: 'paid',
                            paymentIntentId: pi.id,
                            paymentMethodId,
                            cardBrand,
                            chargeId,
                            receiptUrl,
                            paymentConfirmedAt,
                        },
                    });

                    if (booking.assignedDriverId) {
                        await transferDriverPayoutForBooking(booking.id);
                    }
                }
                break;
            }
            case 'payment_intent.payment_failed': {
                const pi = event.data.object;
                if (pi.metadata?.bookingId) {
                    await prisma.booking.update({
                        where: { id: pi.metadata.bookingId },
                        data:  { paymentStatus: 'failed' },
                    });
                }
                break;
            }
            case 'account.updated': {
                const account = event.data.object;
                // updateMany because stripeAccountId is not @unique in the schema
                await prisma.driver.updateMany({
                    where: { stripeAccountId: account.id },
                    data:  { stripeOnboarded: account.details_submitted },
                });
                break;
            }
            default:
                console.log(`Unhandled event type ${event.type}`);
        }
        return res.json({ received: true });
    } catch (error) {
        console.error('Webhook handler error:', error);
        return res.status(500).send('Internal Server Error');
    }
};

// ─── REFUND PAYMENT ───────────────────────────────────────────────────────────

const refundPayment = asyncHandler(async (req, res) => {
    const stripe        = getStripe();
    const { bookingId } = req.body;

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return sendError(res, 404, 'Booking not found');

    const isOwner = booking.userId === req.user.id;
    if (!isOwner && req.user.role !== 'admin') {
        return sendError(res, 403, 'Not authorized to refund this booking');
    }
    if (!booking.paymentIntentId) {
        return sendError(res, 400, 'No payment associated with this booking');
    }
    if (booking.paymentStatus === 'refunded') {
        return sendError(res, 400, 'This booking has already been refunded');
    }

    const refund = await stripe.refunds.create({ payment_intent: booking.paymentIntentId });

    await prisma.booking.update({
        where: { id: bookingId },
        data:  { paymentStatus: 'refunded' },
    });

    return sendSuccess(res, 200, { message: 'Payment refunded successfully', refund });
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    driverConnect,
    driverConnectStatus,
    createPaymentIntent,
    confirmPayment,
    webhook,
    refundPayment,
    transferDriverPayoutForBooking,
};
