const express = require('express');
const bookingController = require('../controllers/bookingController');
const { protect, protectOptional } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/guest', bookingController.createGuestBooking);
router.post('/full', protectOptional, bookingController.createBookingAllInOne);
router.post('/step1', protectOptional, bookingController.createBookingStep1);
router.patch('/:id/step2', protectOptional, bookingController.updateBookingStep2);
router.patch('/:id/step3', protectOptional, bookingController.updateBookingStep3);
router.patch('/:id/step4', protectOptional, bookingController.updateBookingStep4);
router.patch('/:id/step5', protectOptional, bookingController.updateBookingStep5);

router.use(protect);
router.post('/', bookingController.createBooking);
router.get('/me', bookingController.getMyBookings);
router.get('/:id', bookingController.getBookingById);
router.patch('/:id/assign-driver', bookingController.assignDriverToBooking);
router.patch('/:id/full', protect, bookingController.updateBookingAllInOne);
router.patch('/:id', bookingController.updateBooking);
router.delete('/:id', bookingController.deleteBooking);

module.exports = router;
