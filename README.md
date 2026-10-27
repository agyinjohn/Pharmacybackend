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
Customer portal for the demo pharmacy uses slug `medicare`; the sign-in code is `123456` in demo mode (see *Deploy*).

## Design

- **Tenancy**: every document carries `org`; every query is filtered by the caller's org. A pharmacy business is an `Organization` with any number of `Branch`es.
- **Access**: JWT. Roles (11 in the spec: owner, branch_manager, pharmacist, technician, cashier, store_officer, accountant, dispatcher/rider, auditor, plus customers via the portal) are checked per route; branch scope comes from the `x-branch-id` header and the user's assigned branches. Auditors are read-only.
- **Stock**: batch-level per branch (`Batch`). Sales/dispensing use first-expiry-first-out with guarded atomic decrements and roll-back on failure; expired and quarantined batches are never sold. No multi-document transactions are used, so it runs on a standalone `mongod`.
- **Prescriptions**: pharmacist-only verification (registration and licence checked), allergy / duplicate / interaction warnings with an override reason, atomic dispensed-quantity counter on the single shared prescription so it cannot be filled twice across branches, refills and partial fills, controlled drugs need the signed paper original sighted and cannot be refilled when `controlClass = strict`.
- **Controlled-drug register**: append-only (update/delete blocked at model level), running balance per branch and product, disposal needs a witness, CSV extract, reconciliation against shelf stock.
- **Audit log**: immutable; logs create/change/login and every view of a prescription or customer record.
- **Customer portal** (`/api/portal/...`): OTP sign-in, catalogue with live branch stock and substitutes, controlled drugs never exposed, prescription upload, delivery or pickup (the delivery fee is agreed with the customer by phone and recorded on the order by staff), order tracking, cancel before packing. Branches whose licence has lapsed stop taking online orders automatically.
- **Orders**: received / pending_review -> approved (stock taken, Rx verified) -> packed -> out_for_delivery (code for customer) -> delivered (proof) | failed (restock only if intact) | cancelled | rejected.

## Deploy

You need: a MongoDB database (MongoDB Atlas is easiest), a host for this API (any Docker or Node 22 host:
Render, Railway, Fly.io, a VPS) and a host for the web app (Vercel, or the same Docker host). Use HTTPS for both.

1. **Database**: create a MongoDB database and copy its connection string.
2. **API**: deploy this repo (the `Dockerfile` works as is, or run `npm ci --omit=dev && npm start` on Node 22) with:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` (already set in the Docker image) |
   | `MONGODB_URI` | your connection string |
   | `JWT_SECRET` | a long random string, e.g. `openssl rand -hex 32` (the API will not start without it) |
   | `CORS_ORIGIN` | the web app's address, e.g. `https://app.example.com` (comma-separate several) |
   | `PUBLIC_WEB_URL` | the same web address (used for payment return links) |
   | `DEMO_MODE` | `true` for a demo deployment only (see below) |
   | `SMS_PROVIDER`, `ARKESEL_API_KEY`, `SMS_SENDER_ID` | for real text messages (needed for customer sign-in when not in demo mode) |
   | `PAYSTACK_SECRET_KEY` | for real online payments; register `https://<api-host>/api/portal/webhooks/paystack` with Paystack |

   Check `https://<api-host>/api/health` returns `{"ok":true}`.
3. **Demo data** (demo deployment only, wipes the database):
   `SEED_CONFIRM=wipe-and-seed npm run seed` (with the same `MONGODB_URI`), or
   `docker compose run --rm -e SEED_CONFIRM=wipe-and-seed api node src/seed.js`.
4. **Web app**: deploy the `Pharmacy` repo with `NEXT_PUBLIC_API_URL=https://<api-host>/api` (see its README).

**Demo deployment vs live pharmacy**

| | Demo (`DEMO_MODE=true`) | Live (unset) |
|---|---|---|
| Customer sign-in code | Always `OTP_DEMO_CODE` (default `123456`), shown on screen | Random, sent by SMS only |
| Online payment without Paystack | Simulated as paid | Refused: customers choose pay on delivery |
| Demo data | Seed it | Do not seed; create the pharmacy at `/signup` |

## Integrations and operations

| Area | Status |
|---|---|
| Payments | Paystack hosted checkout when `PAYSTACK_SECRET_KEY` is set (stock is held until paid, released after `reservationMinutes`, refunds go back automatically, signature-checked webhook). Otherwise simulated. **Unverified against live Paystack - test with sandbox keys.** |
| SMS | `SMS_PROVIDER=arkesel` or a generic `webhook`; failures are recorded and never break the business action. **Unverified against live gateways.** |
| Offline working | `POST /offline/sync` takes sales, goods received and dispensing of verified (non-controlled) prescriptions, each applied once by `clientId`. Stock shortfalls and possible duplicate fills found after sync are recorded and flagged, not rejected. Snapshots: `GET /pos/catalog`, `GET /offline/rx-snapshot`. Older `POST /sales/sync` still works. |
| Offline selling (legacy) | `GET /pos/catalog` + `POST /sales/sync` (idempotent by `clientId`; stock shortfalls are accepted and flagged). The web till queues sales in IndexedDB. Prescription-only and controlled items need a connection. |
| Rider tracking | Rider phone posts its position; customer sees last position and a map link. External couriers: name, phone and tracking link. |
| Backups | `scripts/backup.sh` (hourly cron, retention, off-site upload hook) and `scripts/restore.sh`. See *Operations* below. |
| Tests | `npm test` (no database needed) and `npm run smoke` (needs a seeded API). CI runs both against a MongoDB service. |
| Data import | `POST /imports/:type` for products, stock, customers (with opening balances) and suppliers; `dryRun: true` returns a row-by-row validation report; each committed run is kept as the data migration report (`GET /imports`). CSV or .xlsx. |
| Excel export | Any report, the controlled-drug register, audit log, product list and data-protection records accept `?format=xlsx`. |
| Promotions and loyalty | Percent, amount-off and buy-X-get-Y promotions by product, category, branch, channel and dates; never on prescription or controlled medicines. Loyalty points earned on spend and redeemable at the till (`loyalty` payment method). |
| Data protection | Record of processing activities, security incident log, per-record retention with preview, hosting location (`/dp/*`). |
| Not built | National e-pharmacy platform (GNEPP), FDA product data, insurance eligibility APIs, tax-authority e-invoicing, courier APIs: each needs access or specs from the client. |

### Operations

- **Deploy**: see *Deploy* below.
- **NFR-06 targets** (<= 1 hour data loss, <= 4 hours to restore): run `scripts/backup.sh` hourly with an off-site `BACKUP_UPLOAD_CMD`, or use Atlas continuous cloud backup. Test `scripts/restore.sh` into a scratch database at least twice a year.
- **Uptime (NFR-04)**: `/api/health` for monitoring. Run two API instances behind a load balancer for 99.5%.
- **Security**: set a strong `JWT_SECRET`, serve over HTTPS, enable MongoDB encryption at rest (Atlas default), and turn on *Require two-step sign-in* in Settings.

## Demo shortcuts (replace before go-live)

| Area | Demo behaviour | Production |
|---|---|---|
| Payments | Simulated in demo mode unless `PAYSTACK_SECRET_KEY` is set | Live: online payment is refused until Paystack is set up; verify it in sandbox first |
| SMS | Logged unless `SMS_PROVIDER` is set; email is not implemented | Verify gateway, add email provider |
| OTP | Fixed code shown on screen in demo mode (`DEMO_MODE=true` or not production) | Sent by SMS only (set `SMS_PROVIDER`) |
| Drug interactions | Small built-in table in `services/clinical.js` | Drug-information provider |
| Prescription images | Stored as data URLs in MongoDB | Object storage |
| GNEPP / FDA / courier / insurance / e-invoicing | Not implemented (phase 3, need client access) | Per integrations list |

Tax rates, approval limits (`PO_LIMIT`), discount limits (`DISCOUNT_LIMIT`) and the 14-day refund window are placeholders to be confirmed with the client.

## Route map (all under `/api`, JSON)

`auth` register / login / me / leads - `org`, `branches`, `users` - `products` (+import, alternatives) - `inventory` (alerts, receive, adjust, quarantine, trace, network) - `suppliers`, `purchase-orders` (approve, send, receive) - `transfers` (request, dispatch, receive, reject) - `pos/lookup`, `sales` (hold, refund), `shifts` - `customers` - `prescriptions` (verify, reject, notes, dispense), `controlled-register` - `orders` (approve, reject, pack, dispatch, deliver, fail, cancel, pass), `rider/tasks` - `reports/*` (dashboard, sales, stock, expiry, margin, tax, purchases, supplier-balances, orders, dispensing; `?format=csv`) - `audit` - `portal/*` (public).

> Note: this was written without access to a MongoDB instance in the build sandbox. Run `npm run seed` against a real database and smoke-test before relying on it.
