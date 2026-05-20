const express = require('express');
const router = express.Router();
const { protect, protectOptional } = require('../middleware/authMiddleware');
const {
    driverConnect,
    driverConnectStatus,
    createPaymentIntent,
    confirmPayment,
    refundPayment
} = require('../controllers/paymentController');

// Driver onboarding routes
router.post('/driver/connect', protect, driverConnect);
router.get('/driver/connect/status', protect, driverConnectStatus);

// Payment execution routes
router.post('/create-payment-intent', protectOptional, createPaymentIntent);
router.post('/confirm', protectOptional, confirmPayment);
router.post('/refund', protect, refundPayment);

module.exports = router;
