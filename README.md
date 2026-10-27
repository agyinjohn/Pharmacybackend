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

## Integrations and operations

| Area | Status |
|---|---|
| Payments | Paystack hosted checkout when `PAYSTACK_SECRET_KEY` is set (stock is held until paid, released after `reservationMinutes`, refunds go back automatically, signature-checked webhook). Otherwise simulated. **Unverified against live Paystack - test with sandbox keys.** |
| SMS | `SMS_PROVIDER=arkesel` or a generic `webhook`; failures are recorded and never break the business action. **Unverified against live gateways.** |
| Offline selling | `GET /pos/catalog` + `POST /sales/sync` (idempotent by `clientId`; stock shortfalls are accepted and flagged). The web till queues sales in IndexedDB. Prescription-only and controlled items need a connection. |
| Rider tracking | Rider phone posts its position; customer sees last position and a map link. External couriers: name, phone and tracking link. |
| Backups | `scripts/backup.sh` (hourly cron, retention, off-site upload hook) and `scripts/restore.sh`. See *Operations* below. |
| Tests | `npm test` (no database needed) and `npm run smoke` (needs a seeded API). CI runs both against a MongoDB service. |
| Not built | National e-pharmacy platform (GNEPP), FDA product data, insurance eligibility APIs, tax-authority e-invoicing, courier APIs: each needs access or specs from the client. |

### Operations

- **Deploy**: `docker compose up --build` (API + MongoDB); set `JWT_SECRET`, `CORS_ORIGIN`, `PUBLIC_WEB_URL`. Use MongoDB Atlas (with continuous backup) for production.
- **NFR-06 targets** (<= 1 hour data loss, <= 4 hours to restore): run `scripts/backup.sh` hourly with an off-site `BACKUP_UPLOAD_CMD`, or use Atlas continuous cloud backup. Test `scripts/restore.sh` into a scratch database at least twice a year.
- **Uptime (NFR-04)**: `/api/health` for monitoring. Run two API instances behind a load balancer for 99.5%.
- **Security**: set a strong `JWT_SECRET`, serve over HTTPS, enable MongoDB encryption at rest (Atlas default), and turn on *Require two-step sign-in* in Settings.

## Demo shortcuts (replace before go-live)

| Area | Demo behaviour | Production |
|---|---|---|
| Payments | Simulated unless `PAYSTACK_SECRET_KEY` is set | Verify the Paystack integration in sandbox |
| SMS | Logged unless `SMS_PROVIDER` is set; email is not implemented | Verify gateway, add email provider |
| OTP | Fixed code returned by the API when `NODE_ENV != production` | Real SMS OTP |
| Drug interactions | Small built-in table in `services/clinical.js` | Drug-information provider |
| Prescription images | Stored as data URLs in MongoDB | Object storage |
| GNEPP / FDA / courier / insurance / e-invoicing | Not implemented (phase 3, need client access) | Per integrations list |

Tax rates, approval limits (`PO_LIMIT`), discount limits (`DISCOUNT_LIMIT`) and the 14-day refund window are placeholders to be confirmed with the client.

## Route map (all under `/api`, JSON)

`auth` register / login / me / leads - `org`, `branches`, `users` - `products` (+import, alternatives) - `inventory` (alerts, receive, adjust, quarantine, trace, network) - `suppliers`, `purchase-orders` (approve, send, receive) - `transfers` (request, dispatch, receive, reject) - `pos/lookup`, `sales` (hold, refund), `shifts` - `customers` - `prescriptions` (verify, reject, notes, dispense), `controlled-register` - `orders` (approve, reject, pack, dispatch, deliver, fail, cancel, pass), `rider/tasks` - `reports/*` (dashboard, sales, stock, expiry, margin, tax, purchases, supplier-balances, orders, dispensing; `?format=csv`) - `audit` - `portal/*` (public).

> Note: this was written without access to a MongoDB instance in the build sandbox. Run `npm run seed` against a real database and smoke-test before relying on it.
