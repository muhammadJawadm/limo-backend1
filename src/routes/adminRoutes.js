const express = require('express');
const adminController = require('../controllers/adminController');
const { protect, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect, requireAdmin);

router.get('/users', adminController.getAllUsers);
router.get('/drivers', adminController.getAllDrivers);
router.get('/vehicle-categories', adminController.getAllVehicleCategories);
router.get('/bookings', adminController.getAllBookings);
router.get('/notifications', adminController.getAllNotifications);
router.get('/payments', adminController.getAllPayments);
router.get('/support-requests', adminController.getAllSupportRequests);
router.post('/send-mail', adminController.sendAdminMail);

module.exports = router;
