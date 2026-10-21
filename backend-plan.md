# Ease Disease: System Plan v3 (final baseline)

**Principle:** proper architecture, security and delivery pipeline from day one, with a **small v1 feature set**. Features grow; the foundations don't get rebuilt.
This supersedes v2 and `claude/day1-mvp-plan.md`.

**v1 features:**
- Google sign-in
- Single package
- Booking via an assessment form (no slots; experts contact the patient after payment)
- **PayU hosted checkout with full payment tracking**
- Booking alert emails
- My Bookings

**Later:** staff/admin portal, phone OTP, refunds UI, multiple packages.

---

## 1. Architecture

```
GitHub (monorepo) ── GitHub Actions ──(Workload Identity Federation, no keys)──► GCP

easedisease.in ─────► Firebase Hosting  (Angular 22 static + CDN + managed TLS)
                         │  Firebase Auth JS SDK (Google sign-in) → ID token
                         │  HTTPS + Authorization: Bearer <Firebase ID token> + X-Firebase-AppCheck
api.easedisease.in ─► Firebase Hosting (2nd site, rewrite ** → Cloud Run)
                         ▼
                Cloud Run "api" (asia-south1, NestJS, min 0 / max 5)
                 ├─ Cloud SQL PostgreSQL 16 (Mumbai, built-in Cloud SQL connection, backups + PITR)
                 ├─ Secret Manager (PayU key/salt/client id/secret, email API key)
                 ├─ firebase-admin (verify ID tokens + App Check tokens)
                 ├─ PayU (test.payu.in / secure.payu.in, verify_payment API)
                 └─ Transactional email API (booking alerts)
Cloud Scheduler ─► POST /v1/internal/tick every 5 min (OIDC-auth'd service account)
                   reconcile payments · retry failed emails
```

**Decisions and reasons**

| Decision | Reason |
|---|---|
| **Firebase Auth: Google sign-in + email link (passwordless)** | Both free. Google covers any Google account; email link covers **any email address**. No passwords, no OTP infrastructure. One account per email, so both methods map to the same user. Phone OTP can be switched on later with protections. The API verifies Firebase ID tokens itself, so auth stays server-enforced. Full flow: `claude/api-flow.md` |
| **Bearer tokens, not cookies** | Firebase keeps the user signed in on the device. Bearer tokens avoid CSRF entirely and sidestep Firebase Hosting's `__session`-only cookie rule |
| **NestJS on Cloud Run** | Containerised, scales to zero, free tier covers 1k users/day, and the same container scales up. Business logic stays server-side for PayU |
| **Cloud SQL PostgreSQL** | Payments need relational integrity, transactions and reporting. db-f1-micro in Mumbai has large headroom at this scale and grows with config changes |
| **API behind a Firebase Hosting site** | Cloud Run custom-domain mapping isn't offered in asia-south1. Hosting gives `api.easedisease.in` a free managed certificate |
| **No Firestore, no NoSQL** | One database, one source of truth, one backup policy |
| **npm workspaces monorepo** | Shared API types between Angular and Nest with no extra build tool (no Nx/Turbo needed yet) |

---

## 2. Repository & delivery (VCS first)

```
easedisease/                        (GitHub, private)
├─ apps/
│  ├─ web/            Angular 22
│  └─ api/            NestJS + Prisma
├─ packages/
│  └─ contracts/      shared TS interfaces: DTOs, enums, error codes (API contract first)
├─ infra/
│  ├─ bootstrap.sh    one-time gcloud setup per environment (APIs, SA, WIF, SQL, secrets)
│  └─ firebase.json   hosting sites, rewrites, security headers
├─ docker-compose.yml local Postgres
├─ .github/workflows/
│  ├─ ci.yml          on PR: lint, typecheck, unit + e2e (Postgres service), build, gitleaks, npm audit
│  ├─ deploy-staging.yml  on merge to main
│  └─ deploy-prod.yml     on release tag, requires manual approval (GitHub Environment)
└─ README.md          local setup in 5 commands
```

**Rules**
- Branch protection on `main`: PR required, CI must pass, no force-push.
- Dependabot on; secret scanning on; `.env*` git-ignored.
- **PayU credentials never go into the repo, chat or tickets.** They go straight into Secret Manager:
  - **test** credentials → staging project
  - **live** credentials → prod project
- Deploy pipeline:
  1. Build container → Artifact Registry.
  2. Run `prisma migrate deploy` as a Cloud Run Job.
  3. Deploy Cloud Run.
  4. `firebase deploy --only hosting`.
  5. Smoke-test `/healthz`.

**Environments**

| Env | GCP/Firebase project | URLs | DB | PayU |
|---|---|---|---|---|
| local | emulator (Auth) | localhost:4200 / :3000 | Docker Postgres | test |
| staging | `easedisease-staging` | staging.easedisease.in / api-staging.easedisease.in | Neon free (Postgres) to keep cost ₹0 | test |
| prod | `easedisease-prod` | easedisease.in / api.easedisease.in | Cloud SQL Mumbai | live |

---

## 3. Data model (PostgreSQL, v1)

Conventions: UUID PKs · `timestamptz` (UTC, shown in IST) · money in **paise** · `created_at`/`updated_at` everywhere.

| Table | Key columns |
|---|---|
| **users** | id, **firebase_uid (unique)**, name, email, phone (E.164), dob?, auth_provider, last_login_at |
| **packages** | id, slug, title, description, price_paise, currency, duration_minutes, **is_active**, sort_order |
| **bookings** | id, reference (`ED-7K3QXM`, unique), user_id, package_id, status, **amount_paise (snapshot)**, **consultee_name, consultee_whatsapp_number (E.164), consultee_email (lower-case, max 50), consultee_age, consultee_city**, consultee_gender? (free text), consultee_dob? (unused), notes?, consent_at, created_ip?, created_user_agent?. `hold_expires_at` exists but is unused. "Consultee" = the person the consultation is for; it may differ from the account (`users`) |
| **transactions** | id, **order_id (= PayU txnid, unique)**, booking_id (unique: one transaction per booking), user_id, gateway, amount_paise, currency, status, payment_mode, **pg_txn_id (mihpayid)**, bank_ref_num, error_code, error_message, completed_at, created_ip?, created_user_agent? |
| **payment_events** | id, transaction_id, source (`RETURN` \| `WEBHOOK` \| `RECONCILE`), hash_valid, payload jsonb (raw), received_at. **Append-only** |
| **notification_recipients** | email, kind (`EXPERT` \| `SHARED_INBOX` \| `ADMIN`), is_active |
| **outbox** | type, payload jsonb, status, attempts, next_attempt_at, last_error |
| **audit_log** | actor, action, entity, entity_id, details jsonb, at |
| **idempotency_keys** | key, user_id, endpoint, request_hash, response jsonb, created_at (purged after 24 h) |

**Statuses**
- Booking: `PENDING_PAYMENT` → `CONFIRMED` → `COMPLETED` / `CANCELLED` / `NO_SHOW`, or `FAILED` (payment failed/cancelled at PayU), or `NEEDS_ATTENTION` (amount mismatch, or paid on a closed booking). `EXPIRED` is defined but never set from our side.
- Transaction: `CREATED` → `INITIATED` → `SUCCESS` / `FAILURE` / `PENDING` / `CANCELLED` (`EXPIRED` defined, unused).

**Booking caps** (per `user_id`, independent of each other), checked inside the insert's DB transaction:
1. Fewer than 5 bookings in `PENDING_PAYMENT` (no time window).
2. Fewer than 5 bookings that reached `CONFIRMED` today (IST calendar day).
There is no slot capacity and no overbooking guard (no slots). The caps need their own concurrency guard because no unique index enforces them.

---

## 4. Flows

### 4.1 Login
1. "Login" (header) or "Book now" → **Continue with Google** (popup) or **Email me a sign-in link** (any email).
   - Set `authDomain: easedisease.in` so sign-in works in browsers that block third-party cookies.
2. Angular interceptor attaches the ID token. `POST /v1/auth/sync` → API verifies the token → upserts the user.
3. First login → profile step: phone (mandatory, E.164) + DOB (optional) → `PATCH /v1/me`.
4. Returning user: Firebase restores the session automatically → `GET /v1/me` → My Bookings.

### 4.2 Booking + payment
1. `GET /v1/packages` → active package.
2. Assessment form: name, WhatsApp, email, age, city, gender?, notes?, consent → `POST /v1/bookings` (signed-in user) → `PENDING_PAYMENT`; price snapshotted from the DB. No slot, no hold.
3. `POST /v1/bookings/{ref}/checkout` → new transaction (`CREATED` → `INITIATED`) → returns the PayU action URL and fields.
   - Hash: `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`, with `udf1` = booking ref.
   - Angular auto-submits the form to PayU.
4. PayU → browser POST to `https://api.easedisease.in/v1/payments/payu/callback` (surl and furl).
5. **One idempotent handler** for callback, webhook and reconciliation:
   1. Save the raw payload to `payment_events`.
   2. Verify the reverse hash.
   3. **Confirm with PayU `verify_payment`** (server-to-server).
   4. Check the amount and txnid.
   5. In one DB transaction: transaction status + booking `CONFIRMED` + outbox email rows.
   Guarded transitions make duplicates no-ops.
6. 303 → `https://easedisease.in/booking/{ref}`. The page polls `GET /v1/bookings/{ref}` until the status is final.
7. **Safety nets:**
   - PayU webhook (set in the PayU dashboard) for users who close the tab.
   - The tick reconciles `INITIATED`/`PENDING` transactions 20 min to 24 h old. Nothing is expired from our side.
8. **Failed payment:** booking → `FAILED`. Not retried on the same booking in v1 (one transaction per booking); the user creates a new booking. A late success still confirms it.
9. **Paid on a closed booking, or amount mismatch:** booking → `NEEDS_ATTENTION` + admin alert → manual decision/refund.

**Credential use:** hosted checkout and `verify_payment` need **key + salt**. Client ID/secret (PayU's OAuth APIs) aren't needed for v1. Store them now for refunds and settlement APIs later.

### 4.3 Booking alert emails
- On `CONFIRMED`, the outbox sends:
  - An alert to all active `notification_recipients`, with booking details incl. notes.
  - A confirmation to the patient, without notes.
- Retried by the tick. SPF/DKIM/DMARC on `easedisease.in`.

---

## 5. API contract (v1)

```
GET   /healthz
POST  /v1/auth/sync                 → { user, profileComplete }
GET   /v1/me                        → { user }
PATCH /v1/me                        { name?, phone, dob? }
GET   /v1/packages                  → Package[]
POST  /v1/bookings                  { packageId, name, whatsappNumber, email, age, city, gender?, notes?, consent: true }
GET   /v1/bookings?status=active|past|all → BookingSummary[] (mine)
GET   /v1/bookings/{ref}            → BookingDetail (mine)
POST  /v1/bookings/{ref}/checkout   → { action, fields }
POST  /v1/payments/payu/callback    (form-urlencoded from PayU; 303 redirect)
POST  /v1/payments/payu/webhook     (from PayU)
POST  /v1/internal/tick             (Cloud Scheduler OIDC only)
Error envelope: { "error": { "code": "DAILY_BOOKING_LIMIT", "message": "...", "details": {} } }
```

Types live in `packages/contracts` and are imported by both Angular and Nest.

---

## 6. Security baseline (v1, not deferred)

| Area | Control |
|---|---|
| AuthN | Firebase ID token verified on every request (`firebase-admin`), revocation check on checkout |
| Bot/abuse | **App Check (reCAPTCHA Enterprise)** token required on booking and checkout endpoints; per-IP + per-user rate limits (Nest throttler); max 5 unpaid and max 5 confirmed-per-day (IST) bookings per user |
| AuthZ | Every query scoped by `user_id`; booking refs are not authorization (ownership checked) |
| Input | DTO validation (whitelist, forbid unknown); price always from DB; form fields bounds-checked server-side |
| Payments | Reverse-hash verify + `verify_payment` + amount match; idempotent transitions; raw event ledger; callback/webhook exempt from auth but authenticated by hash |
| Secrets | Secret Manager only; runtime SA has `secretAccessor` on exactly these secrets; no SA keys anywhere (WIF) |
| Network | HTTPS/HSTS; CORS allowlist (`https://easedisease.in`); Helmet; CSP + frame-ancestors via `firebase.json` |
| Data | Cloud SQL: no authorized networks, IAM/TLS connector, automated backups + PITR, deletion protection; notes never logged |
| Ops | Structured logs, error-rate + 5xx alerts, uptime check on `/healthz`, budget alerts, Cloud Run max instances, DB pool size × max instances < DB connection limit |
| Compliance (DPDP) | Consent timestamp; data minimised; delete/export endpoint in the go-live phase |

---

## 7. Local development

```bash
docker compose up -d                       # Postgres 16
firebase emulators:start --only auth       # fake Google sign-in
cd apps/api && cp .env.example .env.local  # PayU TEST key/salt, DB URL (git-ignored)
npm run prisma:migrate && npm run seed     # schema + one package
npm run start:dev                          # API on :3000
cd apps/web && ng serve                    # :4200, proxy /v1 → :3000
```

- The PayU **test** checkout works locally, because the redirect back to surl is a browser POST, so `localhost` works.
- **Webhooks can't reach localhost.** Use a free Cloudflare Tunnel (`cloudflared tunnel --url localhost:3000`) when testing them, or test webhooks on staging.

## 8. Cost (~1,000 users/day)

| Item | Monthly |
|---|---|
| Firebase Hosting (2 sites) | ₹0–300 (beyond 360 MB/day at $0.15/GB) |
| Firebase Auth (Google sign-in) | ₹0 |
| Cloud Run | ₹0 (free tier: 2M requests) |
| **Cloud SQL db-f1-micro + 10 GB SSD + backups (prod)** | **≈ ₹1,000–1,200** |
| Staging DB (Neon free) | ₹0 |
| Artifact Registry, Secret Manager, Scheduler, Logging | ≈ ₹0–100 |
| Email (provider free tier) | ₹0 |
| **Total** | **≈ ₹1,100–1,600/month + PayU per-transaction fees** |
| Optional phone OTP later | + (OTPs/day − 10) × $0.07 |

## 9. Delivery plan

The "proper" version is **about 4–5 focused working days**, not one.

| Step | Work | Done when |
|---|---|---|
| **S0: Setup** (½ day) | GitHub repo + protections; GCP/Firebase projects (staging, prod), billing + budgets; enable APIs; WIF; Artifact Registry; Cloud SQL; Secret Manager (PayU test/live); Hosting sites + DNS for all four hostnames; PayU dashboard: webhook URL | `main` merge deploys a hello-world API + web to staging automatically |
| **S1: Foundations** (½ day) | Nest skeleton (config validation, error envelope, logging, health), Prisma + migrations, contracts package, CI tests, Angular env + interceptor | CI green; `/healthz` live on staging |
| **S2: Login** (½ day) | Google sign-in, `/auth/sync`, profile, App Check | Sign in on staging; user row created |
| **S3: Booking** (1 day) | Packages, assessment-form booking + count caps, My Bookings, booking page UI (see `docs/plans/S2-S3-login-booking-revision/2026-10-21-login-booking-build-plan.md`) | Create a booking; see it in My Bookings |
| **S4: Payments** (1–1½ days) | Checkout + hash, callback, webhook, verify_payment, reconcile tick, status page, retries | Test payment success/failure/closed-tab all end in the correct state |
| **S5: Alerts + go-live** (½–1 day) | Outbox emails, security headers, alerts, backups check, PayU live switch, prod deploy | First live ₹1 test transaction refunded successfully |

## 10. Open decisions
1. Email provider for alerts (any transactional API; e.g. Resend, Brevo or Amazon SES). The recipient list is configurable either way.
2. ~~Confirm availability: weekly hours + capacity 2~~ Resolved 2026-10-17: no slots; experts contact the patient after payment.
