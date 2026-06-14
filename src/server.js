// server.js
'use strict';

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const http     = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { prisma }    = require('./config/db');
const { initSocket } = require('./socket/index');
const { setIo }     = require('./socket/emitter');

const authRoutes            = require('./routes/authRoutes');
const driverRoutes          = require('./routes/driverRoutes');
const bookingRoutes         = require('./routes/bookingRoutes');
const vehicleCategoryRoutes = require('./routes/vehicleCategoryRoutes');
const chatRoutes            = require('./routes/chatRoutes');
const paymentRoutes         = require('./routes/paymentRoutes');
const notificationRoutes    = require('./routes/notificationRoutes');
const customerRoutes        = require('./routes/customerRoutes');
const adminRoutes           = require('./routes/adminRoutes');
const supportRoutes         = require('./routes/supportRoutes');
const adminChatRoutes       = require('./routes/adminChatRoutes');
const driverChatRoutes      = require('./routes/driverChatRoutes');
const { webhook }           = require('./controllers/paymentController');

const app    = express();
const port   = process.env.PORT || 5000;
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*' },
});

// Make io available to controllers that need req.app.get('io') pattern
app.set('io', io);

// Initialize socket handlers and the emitter singleton
initSocket(io);
setIo(io);

const allowedOrigins = [process.env.FRONTEND_URL, process.env.ADMIN_URL, process.env.FRONTEND_URL1];

// ── MIDDLEWARE ──────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Stripe webhook must come before express.json()
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), webhook);

app.use(express.json({ limit: '10kb' }));

// ── ROUTES ──────────────────────────────────────────────────────
app.get('/',       (_req, res) => res.json({ success: true, message: 'PRVYN Limo App Backend' }));
app.get('/health', (_req, res) => res.json({ success: true, status: 'ok', uptime: process.uptime() }));

app.use('/api/auth',               authRoutes);
app.use('/api/driver',             driverRoutes);
app.use('/api/bookings',           bookingRoutes);
app.use('/api/customer',           customerRoutes);
app.use('/api/vehicle-categories', vehicleCategoryRoutes);
app.use('/api/chat',               chatRoutes);
app.use('/api/payments',           paymentRoutes);
app.use('/api/notifications',      notificationRoutes);
app.use('/api/admin',              adminRoutes);
app.use('/api/support',            supportRoutes);
app.use('/api/admin/chat',         adminChatRoutes);
app.use('/api/driver/chat',        driverChatRoutes);

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// ── ERROR HANDLER ────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message,
  });
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`${signal} — shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── START ────────────────────────────────────────────────────────
async function startServer() {
  try {
    await prisma.$connect();
    console.log('PostgreSQL connected');
    server.listen(port, () => console.log(`Server running on port ${port}`));
  } catch (err) {
    console.error('DB connection failed:', err.message);
    process.exit(1);
  }
}

startServer();