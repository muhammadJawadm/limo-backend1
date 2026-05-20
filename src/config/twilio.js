const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const conversationsClient = client.conversations.v1.services(
    process.env.TWILIO_CHAT_SERVICE_SID
);

module.exports = { client, conversationsClient };