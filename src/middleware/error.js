const { isProd } = require('../config');

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join('; ') });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) {
    return res.status(409).json({ error: `Duplicate value for ${Object.keys(err.keyValue || {}).join(', ') || 'field'}` });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && isProd ? 'Internal server error' : err.message, details: err.details });
};
