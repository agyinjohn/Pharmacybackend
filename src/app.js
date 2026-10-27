const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { staff } = require('./middleware/auth');
const errorHandler = require('./middleware/error');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'x-branch-id'] }));
app.use(express.json({ limit: '8mb' })); // prescription photos arrive as data URLs
if (!config.isProd) app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/portal', require('./routes/portal'));

// Everything below is staff-only; authenticate once for the whole group.
const staffApi = express.Router();
staffApi.use(staff);
['org', 'catalogue', 'inventory', 'sales', 'prescriptions', 'orders', 'reports', 'extras'].forEach((r) => staffApi.use(require(`./routes/${r}`)));
app.use('/api', staffApi);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
