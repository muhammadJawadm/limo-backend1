'use strict';

const express = require('express');
const router = express.Router();
const { getRideMessages } = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

// Get message history for a ride
router.get('/messages/:rideId', protect, getRideMessages);

module.exports = router;