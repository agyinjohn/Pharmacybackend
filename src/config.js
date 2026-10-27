require('dotenv').config({ quiet: true });

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pharmacy_saas',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  webUrl: process.env.PUBLIC_WEB_URL || 'http://localhost:3000',
  otpDemoCode: process.env.OTP_DEMO_CODE || '123456',
  nearExpiryDays: [90, 60, 30],
};
