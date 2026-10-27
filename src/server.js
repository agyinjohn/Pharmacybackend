const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

mongoose.connect(config.mongoUri)
  .then(() => {
    app.listen(config.port, () => console.log(`Pharmacy API listening on :${config.port}`));
    // Free stock held for online orders that were never paid.
    const { releaseExpiredReservations } = require('./routes/orders');
    // Medication reminders (dose times and refill-due), checked every minute.
    const { runReminders } = require('./services/reminders');
    setInterval(() => runReminders().catch((e) => console.error('reminder sweep failed', e.message)), 60000).unref();
    setInterval(() => releaseExpiredReservations().catch((e) => console.error('reservation sweep failed', e.message)), 60000).unref();
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
