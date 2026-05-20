'use strict';

const { prisma }       = require('../config/db');
const bcrypt           = require('bcrypt');
const { generateToken } = require('../utils/jwt');
const otpGenerator     = require('otp-generator');
const sendEmail        = require('../utils/sendEmail');
const asyncHandler     = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/apiResponse');
const { EMAIL_REGEX }  = require('../utils/validators');
const { OTP_EXPIRY_MS } = require('../utils/constants');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Generate a 6-digit numeric OTP. */
const generateOtp = () =>
    otpGenerator.generate(6, {
        digits:            true,
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars:       false,
    });

// ─── REGISTER ────────────────────────────────────────────────────────────────

exports.register = asyncHandler(async (req, res) => {
    let { firstName, lastName, email, phone, password, role, location } = req.body;

    if (!email || !phone || !password || !location || !firstName || !lastName) {
        return sendError(res, 400, 'All fields are required');
    }
    if (!EMAIL_REGEX.test(email)) {
        return sendError(res, 400, 'Invalid email format');
    }
    if (password.length < 8) {
        return sendError(res, 400, 'Password must be at least 8 characters');
    }
    if (role && !['customer', 'driver'].includes(role)) {
        return sendError(res, 400, 'your role must be customer or driver');
    }

    email = email.toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
        return sendError(res, 400, 'User already exists');
    }

    const existingPhone = await prisma.user.findUnique({ where: { phone } });
    if (existingPhone) {
        return sendError(res, 400, 'Phone number already exists');
    }

    const salt           = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await prisma.user.create({
        data: { firstName, lastName, email, phone, password: hashedPassword, role, location },
    });

    const otp       = generateOtp();
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.otp.create({ data: { userId: newUser.id, otp, otpExpiry } });
    await sendEmail(email, otp);

    const token       = generateToken(newUser.id);
    const destination = newUser.role === 'driver'
        ? '/driver/partner-onboarding'
        : '/customer/dashboard';

    return sendSuccess(res, 201, {
        message: 'User registered successfully. Please check your email for the OTP.',
        token,
        destination,
        user: {
            id:                 newUser.id,
            firstName:          newUser.firstName,
            lastName:           newUser.lastName,
            email:              newUser.email,
            phone:              newUser.phone,
            location:           newUser.location,
            role:               newUser.role,
            isVerified:         newUser.isVerified,
            onboardingCompleted: newUser.onboardingCompleted,
        },
    });
});

// ─── VERIFY OTP ──────────────────────────────────────────────────────────────

exports.verifyOtp = asyncHandler(async (req, res) => {
    let { email, otp } = req.body;

    if (!email || !otp) {
        return sendError(res, 400, 'All fields are required');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }

    const otpEntry = await prisma.otp.findFirst({ where: { userId: user.id } });
    if (!otpEntry) {
        return sendError(res, 400, 'OTP not found or already expired');
    }

    // Check expiry BEFORE value
    if (otpEntry.otpExpiry < new Date()) {
        await prisma.otp.deleteMany({ where: { userId: user.id } });
        return sendError(res, 400, 'OTP has expired');
    }
    if (otpEntry.otp !== otp) {
        return sendError(res, 400, 'Invalid OTP');
    }

    await prisma.user.update({ where: { id: user.id }, data: { isVerified: true } });
    await prisma.otp.deleteMany({ where: { userId: user.id } });

    const destination = user.role === 'driver'
        ? (user.onboardingCompleted ? '/driver/dashboard' : '/driver/partner-onboarding')
        : '/customer/dashboard';

    return sendSuccess(res, 200, {
        message: 'Email verified successfully',
        destination,
        user: {
            id:                 user.id,
            role:               user.role,
            onboardingCompleted: user.onboardingCompleted,
            isVerified:         true,
        },
    });
});

// ─── RESEND OTP ───────────────────────────────────────────────────────────────

exports.resendOtp = asyncHandler(async (req, res) => {
    let { email } = req.body;

    if (!email) {
        return sendError(res, 400, 'Email is required');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }
    if (user.isVerified) {
        return sendError(res, 400, 'User is already verified');
    }

    await prisma.otp.deleteMany({ where: { userId: user.id } });

    const otp       = generateOtp();
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.otp.create({ data: { userId: user.id, otp, otpExpiry } });
    await sendEmail(email, otp);

    return sendSuccess(res, 200, { message: 'OTP resent successfully' });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────

exports.forgotPassword = asyncHandler(async (req, res) => {
    let { email } = req.body;

    if (!email) {
        return sendError(res, 400, 'Email is required');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }

    await prisma.otp.deleteMany({ where: { userId: user.id } });

    const otp       = generateOtp();
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.otp.create({ data: { userId: user.id, otp, otpExpiry } });
    await sendEmail(email, otp);

    return sendSuccess(res, 200, { message: 'Password reset OTP sent to your email' });
});

// ─── VERIFY RESET OTP ────────────────────────────────────────────────────────

exports.verifyResetOtp = asyncHandler(async (req, res) => {
    let { email, otp } = req.body;

    if (!email || !otp) {
        return sendError(res, 400, 'All fields are required');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }

    const otpEntry = await prisma.otp.findFirst({ where: { userId: user.id } });
    if (!otpEntry) {
        return sendError(res, 400, 'OTP not found or already expired');
    }

    if (otpEntry.otpExpiry < new Date()) {
        await prisma.otp.deleteMany({ where: { userId: user.id } });
        return sendError(res, 400, 'OTP has expired');
    }
    if (otpEntry.otp !== otp) {
        return sendError(res, 400, 'Invalid OTP');
    }

    // Mark OTP as reset-verified
    await prisma.otp.update({
        where: { id: otpEntry.id },
        data:  { isResetVerified: true },
    });

    return sendSuccess(res, 200, { message: 'OTP verified. You may now reset your password.' });
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

exports.resetPassword = asyncHandler(async (req, res) => {
    let { email, password, confirmPassword } = req.body;

    if (!email || !password || !confirmPassword) {
        return sendError(res, 400, 'All fields are required');
    }
    if (password !== confirmPassword) {
        return sendError(res, 400, 'Passwords do not match');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }

    const otpEntry = await prisma.otp.findFirst({ where: { userId: user.id } });
    if (!otpEntry) {
        return sendError(res, 400, 'Please verify OTP first before resetting password');
    }
    if (!otpEntry.isResetVerified) {
        return sendError(res, 403, 'OTP not verified. Please complete OTP verification first');
    }
    if (otpEntry.otpExpiry < new Date()) {
        await prisma.otp.deleteMany({ where: { userId: user.id } });
        return sendError(res, 400, 'OTP expired. Please request a new one.');
    }

    const salt           = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword } });
    await prisma.otp.deleteMany({ where: { userId: user.id } });

    return sendSuccess(res, 200, { message: 'Password reset successfully' });
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

exports.login = asyncHandler(async (req, res) => {
    let { email, password } = req.body;

    if (!email || !password) {
        return sendError(res, 400, 'All fields are required');
    }

    email = email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        return sendError(res, 404, 'User not found');
    }
    if (!user.isVerified) {
        return sendError(res, 403, 'Please verify your email before logging in');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
        return sendError(res, 401, 'Invalid password');
    }

    const token       = generateToken(user.id);
    const destination = user.role === 'driver'
        ? (user.onboardingCompleted ? '/driver/dashboard' : '/driver/partner-onboarding')
        : '/customer/dashboard';

    return sendSuccess(res, 200, {
        message: 'Login successful',
        token,
        destination,
        user: {
            id:                 user.id,
            firstName:          user.firstName,
            lastName:           user.lastName,
            email:              user.email,
            phone:              user.phone,
            location:           user.location,
            role:               user.role,
            isVerified:         user.isVerified,
            onboardingCompleted: user.onboardingCompleted,
        },
    });
});
