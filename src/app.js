const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { staff } = require('./middleware/auth');
const errorHandler = require('./middleware/error');
const { sendImage } = require('./services/images');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'x-branch-id'] }));
app.use(express.json({ limit: '8mb', verify: (req, res, buf) => { req.rawBody = buf; } })); // photos arrive as data URLs; raw body is kept to check webhook signatures
if (!config.isProd) app.use(morgan('dev'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));
// Product photos are public (shown in the online store); ids are unguessable and cached for a year
// because the URL carries a version that changes on every upload.
app.get('/api/images/products/:id', async (req, res, next) => {
  try {
    const { ProductImage } = require('./models');
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.status(404).end();
    const img = await ProductImage.findOne({ product: req.params.id });
    if (!img) return res.status(404).end();
    sendImage(res, img);
  } catch (e) { next(e); }
});
// Website photos (logo, banner, gallery): each upload has its own id, so the URL never changes content.
app.get('/api/images/site/:id', async (req, res, next) => {
  try {
    const { SiteImage } = require('./models');
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) return res.status(404).end();
    const img = await SiteImage.findById(req.params.id);
    if (!img) return res.status(404).end();
    sendImage(res, img);
  } catch (e) { next(e); }
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/portal', require('./routes/portal'));

// Everything below is staff-only; authenticate once for the whole group.
const staffApi = express.Router();
staffApi.use(staff);
['org', 'catalogue', 'inventory', 'sales', 'prescriptions', 'orders', 'reports', 'extras', 'imports', 'dataprotection', 'offline', 'reminders'].forEach((r) => staffApi.use(require(`./routes/${r}`)));
app.use('/api', staffApi);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
