const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

mongoose.connect(config.mongoUri)
  .then(() => {
    app.listen(config.port, () => console.log(`Pharmacy API listening on :${config.port}`));
  })
  .catch((err) => {
    console.error('Could not connect to MongoDB:', err.message);
    process.exit(1);
  });
