const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

mongoose.connect(config.mongoUri)
  .then(async () => {
    // Auto-seed on first deploy: if no org exists and DEMO_MODE is on, seed the demo data.
    if (config.demoMode) {
      const { Organization } = require('./models');
      const { runSeed, SEED_VERSION } = require('./seed');
      const org = await Organization.findOne({}, 'seedVersion').lean();
      if (!org || (org.seedVersion || 0) < SEED_VERSION) {
        console.log(`Seed version ${org?.seedVersion || 0} < ${SEED_VERSION} — running demo seed...`);
        await runSeed();
      }
    }

    app.listen(config.port, () => console.log(`Pharmacy API listening on :${config.port}`));
    const { releaseExpiredReservations } = require('./routes/orders');
    const { runReminders } = require('./services/reminders');
    setInterval(() => runReminders().catch((e) => console.error('reminder sweep failed', e.message)), 60000).unref();
    setInterval(() => releaseExpiredReservations().catch((e) => console.error('reservation sweep failed', e.message)), 60000).unref();
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
