# Pharmacy SaaS - API

Node.js + Express + MongoDB (Mongoose) backend for a multi-tenant, multi-branch pharmacy management platform.
Built from the *Pharmacy Management System - Requirements Specification* (Ghana).

## Run it

```bash
cp .env.example .env        # set MONGODB_URI (local mongod or Atlas)
npm install
npm run seed                # WARNING: drops the database, loads a 3-branch demo group
npm run dev                 # http://localhost:4000/api/health
```

Demo logins (password `Demo@1234`): `owner@demo.com`, `manager@demo.com`, `pharmacist@demo.com`,
`cashier@demo.com`, `store@demo.com`, `tech@demo.com`, `accountant@demo.com`, `rider@demo.com`, `auditor@demo.com`.
Customer portal for the demo pharmacy uses slug `medicare`; the sign-in code is `123456` outside production.

## Design

- **Tenancy**: every document carries `org`; every query is filtered by the caller's org. A pharmacy business is an `Organization` with any number of `Branch`es.
- **Access**: JWT. Roles (11 in the spec: owner, branch_manager, pharmacist, technician, cashier, store_officer, accountant, dispatcher/rider, auditor, plus customers via the portal) are checked per route; branch scope comes from the `x-branch-id` header and the user's assigned branches. Auditors are read-only.
- **Stock**: batch-level per branch (`Batch`). Sales/dispensing use first-expiry-first-out with guarded atomic decrements and roll-back on failure; expired and quarantined batches are never sold. No multi-document transactions are used, so it runs on a standalone `mongod`.
- **Prescriptions**: pharmacist-only verification (registration and licence checked), allergy / duplicate / interaction warnings with an override reason, atomic dispensed-quantity counter on the single shared prescription so it cannot be filled twice across branches, refills and partial fills, controlled drugs need the signed paper original sighted and cannot be refilled when `controlClass = strict`.
- **Controlled-drug register**: append-only (update/delete blocked at model level), running balance per branch and product, disposal needs a witness, CSV extract, reconciliation against shelf stock.
- **Audit log**: immutable; logs create/change/login and every view of a prescription or customer record.
- **Customer portal** (`/api/portal/...`): OTP sign-in, catalogue with live branch stock and substitutes, controlled drugs never exposed, prescription upload, delivery zones and fees, order tracking, cancel before packing. Branches whose licence has lapsed stop taking online orders automatically.
- **Orders**: received / pending_review -> approved (stock taken, Rx verified) -> packed -> out_for_delivery (code for customer) -> delivered (proof) | failed (restock only if intact) | cancelled | rejected.

## Demo shortcuts (replace before go-live)

| Area | Demo behaviour | Production |
|---|---|---|
| Payments | Mobile money / card are simulated as "paid" with a reference | Payment provider integration; never store card data |
| SMS / email | `services/notify.js` logs to console | SMS gateway + email service |
| OTP | Fixed code returned by the API when `NODE_ENV != production` | Real SMS OTP |
| Drug interactions | Small built-in table in `services/clinical.js` | Drug-information provider |
| Prescription images | Stored as data URLs in MongoDB | Object storage |
| Offline selling (NFR-05) | Not implemented | Needs a local-first client + sync |
| GNEPP / FDA / courier / insurance / e-invoicing | Not implemented (phase 3, need client access) | Per integrations list |

Tax rates, approval limits (`PO_LIMIT`), discount limits (`DISCOUNT_LIMIT`) and the 14-day refund window are placeholders to be confirmed with the client.

## Route map (all under `/api`, JSON)

`auth` register / login / me / leads - `org`, `branches`, `users` - `products` (+import, alternatives) - `inventory` (alerts, receive, adjust, quarantine, trace, network) - `suppliers`, `purchase-orders` (approve, send, receive) - `transfers` (request, dispatch, receive, reject) - `pos/lookup`, `sales` (hold, refund), `shifts` - `customers` - `prescriptions` (verify, reject, notes, dispense), `controlled-register` - `orders` (approve, reject, pack, dispatch, deliver, fail, cancel, pass), `rider/tasks` - `reports/*` (dashboard, sales, stock, expiry, margin, tax, purchases, supplier-balances, orders, dispensing; `?format=csv`) - `audit` - `portal/*` (public).

> Note: this was written without access to a MongoDB instance in the build sandbox. Run `npm run seed` against a real database and smoke-test before relying on it.
