const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
    }
});

// BUG-3 FIX: email now says "5 minutes" matching the 300000ms (5 min) expiry set in controllers.
const sendEmail = async (email, otp) => {
    await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: email,
        subject: "OTP Verification",
        html: `
            <h2>Your OTP Code</h2>
            <p>Use this OTP to verify your account:</p>
            <h1 style="letter-spacing: 8px;">${otp}</h1>
            <p>This OTP expires in <b>5 minutes</b>.</p>
            <p>If you did not request this, ignore this email.</p>
        `,
    });
    console.log("Email sent successfully");
};

const sendEmailAdmin = async (mailData) => {
    const { to, subject, message, html, text, from } = mailData || {};

    await transporter.sendMail({
        from: from || process.env.MAIL_USER,
        to,
        subject,
        text: text || message,
        html: html || (message ? `<p>${message}</p>` : undefined),
    });
    console.log("Email sent successfully");
};

module.exports = sendEmail;
module.exports.sendEmail = sendEmail;
module.exports.sendEmailAdmin = sendEmailAdmin;