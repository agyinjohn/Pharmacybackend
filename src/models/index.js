const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { Schema } = mongoose;
const ref = (model, extra = {}) => ({ type: Schema.Types.ObjectId, ref: model, ...extra });
const opts = { timestamps: true };

const ROLES = [
  'owner', 'branch_manager', 'pharmacist', 'technician', 'cashier',
  'store_officer', 'accountant', 'dispatcher', 'auditor',
];
const LEGAL = ['otc', 'pharmacy_only', 'prescription_only', 'controlled'];

/* ---------- Organisation / tenant ---------- */
const Organization = mongoose.model('Organization', new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  plan: { type: String, enum: ['starter', 'growth', 'enterprise'], default: 'growth' },
  dpcRegistration: String,
  settings: {
    purchasing: { type: String, enum: ['central', 'branch'], default: 'branch' },
    codEnabled: { type: Boolean, default: true },
    nearExpiryDays: { type: [Number], default: [90, 60, 30] },
    reservationMinutes: { type: Number, default: 60 },
    shareStockAcrossBranches: { type: Boolean, default: true },
    requireTwoStep: { type: Boolean, default: false },
    retentionYears: { type: Number, default: 2 },
  },
}, opts));

const Branch = mongoose.model('Branch', new Schema({
  org: ref('Organization', { required: true, index: true }),
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, uppercase: true, trim: true },
  address: String,
  phone: String,
  email: String,
  licenseNumber: String,
  licenseExpiry: Date,
  superintendent: String,
  openingHours: String,
  taxId: String,
  receiptHeader: String,
  onlineEnabled: { type: Boolean, default: true },
  location: { lat: Number, lng: Number },
  deliveryZones: [{ name: String, fee: Number, etaMins: Number }],
  active: { type: Boolean, default: true },
}, opts).index({ org: 1, code: 1 }, { unique: true }));

const userSchema = new Schema({
  org: ref('Organization', { required: true, index: true }),
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  branches: [ref('Branch')],
  phone: String,
  pharmacistRegNo: String,
  pharmacistLicenseExpiry: Date,
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
  totp: { secret: { type: String, select: false }, enabled: { type: Boolean, default: false } },
}, opts);
userSchema.methods.setPassword = async function (pw) { this.passwordHash = await bcrypt.hash(pw, 10); };
userSchema.methods.checkPassword = function (pw) { return bcrypt.compare(pw, this.passwordHash); };
userSchema.methods.isPharmacistInGoodStanding = function () {
  return this.role === 'pharmacist' && !!this.pharmacistRegNo
    && (!this.pharmacistLicenseExpiry || this.pharmacistLicenseExpiry > new Date());
};
userSchema.set('toJSON', { transform: (d, r) => { delete r.passwordHash; if (r.totp) delete r.totp.secret; return r; } });
const User = mongoose.model('User', userSchema);

/* ---------- Catalogue and stock ---------- */
const Product = mongoose.model('Product', new Schema({
  org: ref('Organization', { required: true, index: true }),
  brand: { type: String, required: true, trim: true },
  generic: { type: String, trim: true, index: true },
  strength: String,
  form: String,
  packSize: String,
  manufacturer: String,
  barcode: { type: String, index: true },
  category: { type: String, default: 'General' },
  isDrug: { type: Boolean, default: true },
  legalStatus: { type: String, enum: LEGAL, default: 'otc' },
  controlClass: { type: String, enum: ['standard', 'strict'], default: 'standard' },
  fdaRegNo: String,
  price: { type: Number, required: true, min: 0 },
  cost: { type: Number, default: 0, min: 0 },
  taxRate: { type: Number, default: 0, min: 0, max: 1 },
  branchPrices: [{ branch: ref('Branch'), price: Number }],
  reorderLevel: { type: Number, default: 10 },
  branchReorder: [{ branch: ref('Branch'), level: Number }],
  storage: { type: String, enum: ['ambient', 'cold_chain'], default: 'ambient' },
  symptoms: [String],
  active: { type: Boolean, default: true },
}, opts).index({ brand: 'text', generic: 'text' }));

const Batch = mongoose.model('Batch', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  product: ref('Product', { required: true }),
  batchNo: { type: String, required: true },
  expiry: { type: Date, required: true },
  qty: { type: Number, required: true, min: 0 },
  cost: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'quarantined'], default: 'active' },
  quarantineReason: String,
  supplier: ref('Supplier'),
}, opts).index({ branch: 1, product: 1, expiry: 1 }));

const Supplier = mongoose.model('Supplier', new Schema({
  org: ref('Organization', { required: true, index: true }),
  name: { type: String, required: true },
  contact: String,
  phone: String,
  email: String,
  licenseNumber: String,
  licenseExpiry: Date,
  paymentTerms: String,
  creditLimit: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
}, opts));

const PurchaseOrder = mongoose.model('PurchaseOrder', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  poNo: { type: String, required: true },
  supplier: ref('Supplier', { required: true }),
  items: [{
    product: ref('Product', { required: true }),
    name: String,
    qty: { type: Number, required: true, min: 1 },
    cost: { type: Number, required: true, min: 0 },
    receivedQty: { type: Number, default: 0 },
  }],
  total: Number,
  status: { type: String, enum: ['draft', 'approved', 'sent', 'partial', 'received', 'cancelled'], default: 'draft' },
  createdBy: ref('User'),
  approvedBy: ref('User'),
  receipts: [{ at: Date, by: ref('User'), invoiceNo: String, invoiceTotal: Number, receivedValue: Number, mismatch: Boolean }],
}, opts));

const StockTransfer = mongoose.model('StockTransfer', new Schema({
  org: ref('Organization', { required: true, index: true }),
  ref: String,
  from: ref('Branch', { required: true }),
  to: ref('Branch', { required: true }),
  status: { type: String, enum: ['requested', 'approved', 'in_transit', 'received', 'rejected'], default: 'requested' },
  items: [{
    product: ref('Product', { required: true }),
    name: String,
    qty: Number,
    receivedQty: Number,
    lots: [{ batchNo: String, expiry: Date, qty: Number, cost: Number }],
  }],
  requestedBy: ref('User'),
  approvedBy: ref('User'),
  receivedBy: ref('User'),
  hasVariance: { type: Boolean, default: false },
  note: String,
}, opts));

/* ---------- People ---------- */
const Customer = mongoose.model('Customer', new Schema({
  org: ref('Organization', { required: true, index: true }),
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  addresses: [{ label: String, line: String, digitalAddress: String, zone: String, lat: Number, lng: Number }],
  allergies: [String],
  conditions: [String],
  consent: { communications: Boolean, healthData: Boolean, at: Date },
  loyaltyPoints: { type: Number, default: 0 },
  creditLimit: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
  otp: { code: String, expiresAt: Date, tries: { type: Number, default: 0 } },
  erasureRequestedAt: Date,
  anonymizedAt: Date,
}, opts).index({ org: 1, phone: 1 }, { unique: true }));

/* ---------- Prescriptions ---------- */
const Prescription = mongoose.model('Prescription', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  rxNo: { type: String, required: true },
  customer: ref('Customer'),
  patientName: { type: String, required: true },
  prescriber: { name: { type: String, required: true }, regNo: String, facility: String, address: String },
  writtenOn: { type: Date, default: Date.now },
  source: { type: String, enum: ['walk_in', 'online', 'prescriber'], default: 'walk_in' },
  image: String, // data URL or storage URL of the paper original / photo
  paperOriginalSeen: { type: Boolean, default: false },
  items: [{
    product: ref('Product', { required: true }),
    name: String,
    dose: String,
    frequency: String,
    duration: String,
    qty: { type: Number, required: true, min: 1 },
    dispensedQty: { type: Number, default: 0 },
  }],
  refillsAllowed: { type: Number, default: 0 },
  refillsUsed: { type: Number, default: 0 },
  hasControlled: { type: Boolean, default: false },
  status: { type: String, enum: ['pending', 'verified', 'partial', 'dispensed', 'rejected'], default: 'pending' },
  verifiedBy: ref('User'),
  verifiedAt: Date,
  rejectedReason: String,
  insurance: { scheme: String, memberNo: String, copay: Number },
  notes: [{ at: { type: Date, default: Date.now }, by: ref('User'), type: { type: String, enum: ['counselling', 'intervention', 'decline', 'message'] }, text: String }],
  dispensings: [{ at: Date, by: ref('User'), sale: ref('Sale'), lines: [{ product: ref('Product'), qty: Number, batchNo: String }] }],
  allergyWarnings: [String],
  lastReminderAt: Date,
}, opts).index({ org: 1, rxNo: 1 }, { unique: true }));

// Append-only register; entries are corrected by adding a new signed entry, never edited.
const registerSchema = new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  product: ref('Product', { required: true }),
  productName: String,
  type: { type: String, enum: ['receipt', 'supply', 'disposal', 'correction'], required: true },
  qty: { type: Number, required: true },
  balance: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  counterparty: String, // supplier or recipient
  patient: String,
  prescriber: String,
  prescriberAddress: String,
  rxNo: String,
  batchNo: String,
  pharmacist: ref('User'),
  pharmacistName: String,
  witness: String,
  note: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
const immutable = () => { throw new Error('Controlled-drug register entries cannot be changed'); };
['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'replaceOne'].forEach((h) => registerSchema.pre(h, immutable));
registerSchema.pre('save', function () { if (!this.isNew) immutable(); });
const ControlledRegister = mongoose.model('ControlledRegister', registerSchema);

/* ---------- Sales ---------- */
const Shift = mongoose.model('Shift', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  cashier: ref('User', { required: true }),
  openedAt: { type: Date, default: Date.now },
  closedAt: Date,
  openingCash: { type: Number, default: 0 },
  cashSales: { type: Number, default: 0 },
  expectedCash: Number,
  countedCash: Number,
  variance: Number,
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
}, opts));

const Sale = mongoose.model('Sale', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true, index: true }),
  receiptNo: { type: String, required: true },
  cashier: ref('User', { required: true }),
  customer: ref('Customer'),
  shift: ref('Shift'),
  prescription: ref('Prescription'),
  channel: { type: String, enum: ['pos', 'online'], default: 'pos' },
  clientId: String, // idempotency key for sales made offline and synced later
  offlineAt: Date,
  flags: [String],  // problems found when an offline sale was synced (stock shortfall, etc.)
  items: [{
    product: ref('Product', { required: true }),
    name: String,
    qty: Number,
    shortfall: Number,
    unitPrice: Number,
    taxRate: Number,
    tax: Number,
    lineTotal: Number,
    cost: Number,
    lots: [{ batch: ref('Batch'), batchNo: String, expiry: Date, qty: Number }],
  }],
  subtotal: Number,
  discount: { type: Number, default: 0 },
  tax: Number,
  total: Number,
  payments: [{ method: { type: String, enum: ['cash', 'momo', 'card', 'credit'] }, amount: Number, reference: String }],
  changeGiven: { type: Number, default: 0 },
  status: { type: String, enum: ['completed', 'held', 'refunded', 'partially_refunded'], default: 'completed' },
  refunds: [{ at: Date, by: ref('User'), reason: String, amount: Number, lines: [{ product: ref('Product'), qty: Number }] }],
}, opts).index({ branch: 1, createdAt: -1 }).index({ org: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }));

/* ---------- Online orders ---------- */
const Order = mongoose.model('Order', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true, index: true }),
  orderNo: { type: String, required: true },
  customer: ref('Customer', { required: true }),
  items: [{
    product: ref('Product', { required: true }),
    name: String,
    qty: Number,
    unitPrice: Number,
    taxRate: Number,
    requiresRx: Boolean,
    lots: [{ batch: ref('Batch'), batchNo: String, expiry: Date, qty: Number }],
  }],
  prescription: ref('Prescription'),
  fulfilment: { type: String, enum: ['delivery', 'pickup'], default: 'delivery' },
  address: { line: String, digitalAddress: String, zone: String },
  deliveryFee: { type: Number, default: 0 },
  etaMins: Number,
  subtotal: Number,
  tax: Number,
  total: Number,
  payment: { method: { type: String, enum: ['momo', 'card', 'cod'] }, status: { type: String, enum: ['pending', 'paid', 'refunded'], default: 'pending' }, reference: String, provider: String, authUrl: String, refundedAmount: Number },
  status: { type: String, enum: ['pending_review', 'received', 'approved', 'packed', 'out_for_delivery', 'delivered', 'failed', 'cancelled', 'rejected'], default: 'received' },
  stockReserved: { type: Boolean, default: false },
  rxClaimed: { type: Boolean, default: false },
  reservedUntil: Date,
  rider: { user: ref('User'), name: String, phone: String, external: Boolean, trackingUrl: String, location: { lat: Number, lng: Number, at: Date } },
  deliveryCode: String,
  proof: { recipient: String, at: Date, signature: String },
  history: [{ status: String, at: { type: Date, default: Date.now }, by: String, note: String }],
  messages: [{ at: { type: Date, default: Date.now }, from: { type: String, enum: ['pharmacist', 'customer'] }, text: String }],
  reviewNote: String,
  passedFrom: ref('Branch'),
}, opts).index({ branch: 1, createdAt: -1 }));

const SupplierReturn = mongoose.model('SupplierReturn', new Schema({
  org: ref('Organization', { required: true, index: true }),
  branch: ref('Branch', { required: true }),
  supplier: ref('Supplier', { required: true }),
  creditNoteNo: { type: String, required: true },
  items: [{ product: ref('Product'), name: String, batchNo: String, qty: Number, cost: Number }],
  reason: { type: String, required: true },
  total: Number,
  createdBy: ref('User'),
}, opts));

const Notification = mongoose.model('Notification', new Schema({
  org: ref('Organization', { index: true }),
  customer: ref('Customer'),
  phone: String,
  channel: { type: String, enum: ['sms', 'email', 'push'], default: 'sms' },
  event: String,
  message: String,
  status: { type: String, enum: ['sent', 'skipped', 'failed'], default: 'sent' },
  skippedReason: String,
}, { timestamps: { createdAt: true, updatedAt: false } }));

// Customer account ledger: credit sales are charges, money received are payments.
const Ledger = mongoose.model('Ledger', new Schema({
  org: ref('Organization', { required: true, index: true }),
  customer: ref('Customer', { required: true, index: true }),
  type: { type: String, enum: ['charge', 'payment'], required: true },
  amount: { type: Number, required: true },
  ref: String,
  sale: ref('Sale'),
  by: ref('User'),
}, { timestamps: { createdAt: true, updatedAt: false } }));

// One record per data import run: the data migration report (NFR-12, deliverable 10.2).
const ImportLog = mongoose.model('ImportLog', new Schema({
  org: ref('Organization', { required: true, index: true }),
  type: String,
  fileName: String,
  by: ref('User'),
  byName: String,
  total: Number,
  created: Number,
  updated: Number,
  skipped: Number,
  rowErrors: [{ row: Number, error: String }],
}, { timestamps: { createdAt: true, updatedAt: false } }));

/* ---------- Audit and leads ---------- */
const auditSchema = new Schema({
  org: ref('Organization', { index: true }),
  branch: ref('Branch'),
  user: ref('User'),
  userName: String,
  action: { type: String, required: true },
  entity: String,
  entityId: String,
  summary: String,
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
auditSchema.index({ org: 1, createdAt: -1 });
['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'replaceOne'].forEach((h) => auditSchema.pre(h, () => { throw new Error('Audit logs cannot be changed'); }));
const AuditLog = mongoose.model('AuditLog', auditSchema);

const Lead = mongoose.model('Lead', new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: String,
  pharmacy: String,
  branches: String,
  message: String,
}, opts));

module.exports = {
  ROLES, LEGAL,
  Organization, Branch, User, Product, Batch, Supplier, PurchaseOrder, StockTransfer,
  Customer, Prescription, ControlledRegister, Shift, Sale, Order, AuditLog, Lead, SupplierReturn, Notification, Ledger, ImportLog,
};
