const mongoose = require('mongoose');
const { Batch, ControlledRegister } = require('../models');
const { conflict } = require('../utils/http');

const oid = (v) => new mongoose.Types.ObjectId(String(v));

const priceFor = (product, branchId) => {
  const o = (product.branchPrices || []).find((p) => String(p.branch) === String(branchId));
  return o ? o.price : product.price;
};

const reorderFor = (product, branchId) => {
  const o = (product.branchReorder || []).find((p) => String(p.branch) === String(branchId));
  return o ? o.level : product.reorderLevel;
};

const sellable = (org, branch, product) => ({
  org: oid(org), branch: oid(branch), product: oid(product),
  status: 'active', qty: { $gt: 0 }, expiry: { $gt: new Date() },
});

const available = async (org, branch, product) => {
  const [r] = await Batch.aggregate([{ $match: sellable(org, branch, product) }, { $group: { _id: null, qty: { $sum: '$qty' } } }]);
  return r ? r.qty : 0;
};

const restore = async (lots) => {
  for (const l of lots) await Batch.updateOne({ _id: l.batch }, { $inc: { qty: l.qty } });
};

// First-expiry-first-out allocation. Every decrement is guarded so concurrent sales cannot take
// the same units; if a later lot fails, earlier decrements are put back.
const deductFefo = async ({ org, branch, product, qty, label }) => {
  const batches = await Batch.find(sellable(org, branch, product)).sort({ expiry: 1, createdAt: 1 });
  const total = batches.reduce((s, b) => s + b.qty, 0);
  if (total < qty) throw conflict(`Not enough stock for ${label || 'item'} (need ${qty}, have ${total}${total ? ' non-expired' : ''})`);
  const done = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(b.qty, left);
    const res = await Batch.updateOne({ _id: b._id, qty: { $gte: take }, status: 'active' }, { $inc: { qty: -take } });
    if (res.modifiedCount !== 1) continue; // lost a race on this lot; try the next one
    done.push({ batch: b._id, batchNo: b.batchNo, expiry: b.expiry, qty: take, cost: b.cost });
    left -= take;
  }
  if (left > 0) {
    await restore(done);
    throw conflict(`Stock for ${label || 'item'} changed while selling; please retry`);
  }
  return done;
};

const addBatch = ({ org, branch, product, batchNo, expiry, qty, cost, supplier }) => Batch.findOneAndUpdate(
  { org, branch, product, batchNo, expiry: new Date(expiry) },
  { $inc: { qty }, $set: { cost, ...(supplier ? { supplier } : {}) }, $setOnInsert: { status: 'active' } },
  { upsert: true, new: true },
);

// Controlled-drug register: append-only with a running balance per branch and product.
const registerEntry = async (data) => {
  const last = await ControlledRegister.findOne({ branch: data.branch, product: data.product }).sort({ createdAt: -1, _id: -1 });
  const prev = last ? last.balance : 0;
  const delta = ['receipt', 'correction'].includes(data.type) ? data.qty : -data.qty;
  return ControlledRegister.create({ ...data, balance: prev + delta });
};

module.exports = { priceFor, reorderFor, available, deductFefo, restore, addBatch, registerEntry, oid };
