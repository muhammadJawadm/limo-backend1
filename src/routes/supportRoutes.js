const express = require('express');
const supportController = require('../controllers/supportController');
const { protect, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/', supportController.createSupportRequest);

router.use(protect, requireAdmin);

router.get('/', supportController.getAllSupportRequests);
router.get('/:id', supportController.getSupportRequestById);
router.patch('/:id/read', supportController.markSupportRequestAsRead);

module.exports = router;