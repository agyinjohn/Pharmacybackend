require('dotenv').config({ quiet: true });

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

// Demo mode: fixed one-time code shown on screen, simulated online payments. Always on outside production;
// in production only when DEMO_MODE=true (for a demo deployment, never for a live pharmacy).
const demoMode = !isProd || process.env.DEMO_MODE === 'true';

module.exports = {
  isProd,
  demoMode,
  port: Number(process.env.PORT) || 4000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pharmacy_saas',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  webUrl: process.env.PUBLIC_WEB_URL || 'http://localhost:3000',
  otpDemoCode: process.env.OTP_DEMO_CODE || '123456',
  nearExpiryDays: [90, 60, 30],
};
