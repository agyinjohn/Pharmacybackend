const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

mongoose.connect(config.mongoUri)
  .then(() => {
    app.listen(config.port, () => console.log(`Pharmacy API listening on :${config.port}`));
    // Free stock held for online orders that were never paid.
    const { releaseExpiredReservations } = require('./routes/orders');
    setInterval(() => releaseExpiredReservations().catch((e) => console.error('reservation sweep failed', e.message)), 60000).unref();
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
