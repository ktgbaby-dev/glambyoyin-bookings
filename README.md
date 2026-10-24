# GLAM BY OYIN bookings

Online booking for GLAM BY OYIN, a makeup and lash artist in Lagos. Clients pick a service, a day and a time, pay a deposit (or the full price) by bank transfer, optionally upload a receipt, and get a booking code. The studio confirms payments from a password-protected desk.

Live at https://glambyoyin-bookings.vercel.app. The brand site is a separate project (`glambyoyin`).

## How it is built

- `public/` is a static site: `index.html`, `app.js` (client page), `owner.js` (the desk, loaded at `/#owner`), `lib.js`, and `css/style.css`. No framework and no build step.
- `api/` holds the Node serverless functions Vercel runs: `public`, `book`, `status`, `auth`, `account`, `owner` and `proof`, plus `cron/reminders` (the daily job). Shared code is in `api/_lib/`.
- Data lives in one **private Vercel Blob store**. There is no database.

| Path in the store | What it holds |
| --- | --- |
| `settings.json` | Studio details, services and looks, prices, hours, deposit, bank details, policy |
| `days/YYYY-MM-DD.json` | Which slots are taken that day. The single source of truth for availability |
| `bookings/<id>.json` | One booking |
| `proofs/<id>` | The receipt image for a booking |
| `users.json` | The logins, with salted password hashes |
| `rl/...` | Rate limit counters, keyed by a hash of the visitor's address |

Double bookings are prevented by writing each day's file only if nobody changed it since it was read (a version tag check), with a few retries. Prices, deposits and totals are always worked out on the server.

## Environment variables

Set these on the Vercel project (Settings, Environment Variables). See `.env.example`.

| Name | Required | What it is |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | yes | Added automatically when the Blob store is connected to the project |
| `SESSION_SECRET` | yes | At least 16 random characters. Signs the sign-in cookies. Changing it signs everyone out |
| `OWNER_PASSWORD` | yes | The **recovery password**. It opens any admin login if a password is forgotten. Keep it somewhere safe |
| `CRON_SECRET` | yes, for reminders | At least 16 random characters. Vercel sends it to the daily job as `Authorization: Bearer ...`, and the job refuses anything else |
| `RESEND_API_KEY` | no | Turns on the emails to the studio: the new-booking alert and the 48 hour reminders |
| `NOTIFY_EMAIL` | no | Who gets that email, comma separated. Defaults to the studio email in Settings |
| `NOTIFY_FROM` | no | The sender. Defaults to `GLAM BY OYIN <onboarding@resend.dev>` |

With Resend's free test sender, email can only be delivered to the address the Resend account was created with. To send to anyone else, verify a domain in Resend and set `NOTIFY_FROM` to an address on it.

## Appointment reminders

The studio gets an email 48 hours before each appointment, through the same Resend channel and to the same address as the new-booking alert.

- **How:** as soon as a booking qualifies, the reminder is *scheduled with Resend* (`scheduled_at`, up to 30 days ahead; bookings are at most 21 days ahead). Resend sends it at the exact 48 hour mark, so nothing has to be running at that moment. The state of each reminder is kept on the booking (`booking.reminder`) and shown on the desk as the "Reminder" line.
- **Which bookings:** confirmed ones, and ones with a receipt that are waiting to be confirmed. An unpaid booking that only holds a slot gets none until its payment is confirmed. A booking made less than 48 hours ahead gets none, and one is never sent late or at once.
- **When something changes:** rejecting, marking a no-show or deleting cancels the scheduled email. If the appointment time ever changes, the old reminder is cancelled and a new one scheduled. Turning "reminders" off in Settings cancels the pending ones.
- **No duplicates:** each booking is claimed with a conditional write before Resend is called, and every request carries a fixed idempotency key, so repeated runs, retries and concurrent workers cannot send two.
- **Failures:** a temporary failure (no answer, rate limit, server error) is retried after 15 minutes, 1 hour, 3 hours, 12 hours and 24 hours, six tries in all. A refusal that will not change (for example a bad request) is not retried. Everything is logged without the key.
- **The daily safety net:** `vercel.json` runs `/api/cron/reminders` once a day (06:00 UTC). It schedules reminders that were missed (for example bookings made before the Resend key was added), cancels ones that should not exist, retries cancellations that failed, and records whether each reminder was delivered. On Vercel's Hobby plan a cron job can run only once a day, which is why the sending itself is not done by cron.
- **Needs:** `RESEND_API_KEY`, and `CRON_SECRET` for the daily job. With Resend's free test sender, mail can only be delivered to the address the Resend account was created with.

## Logins and passwords

The desk uses separate logins, each with its own password (`users.json`). A new login starts on a temporary password and must choose its own at first sign-in. Anyone can change their password, or sign out their other devices, from the **Account** tab. A login that manages logins can also add, reset and remove logins there.

If every admin password is forgotten, sign in with an admin's username and the `OWNER_PASSWORD` value, then reset the password from the Account tab.

Before any login exists, the desk falls back to a single shared password: `OWNER_PASSWORD`.

## Booking rules worth knowing

- A booking with something to pay and no receipt holds its slot for **3 hours** by default (Settings, "Hold an unpaid booking for"; 0 means until the owner decides). A booking with a receipt is never released by the clock.
- Booking requests are limited to 12 per 10 minutes per visitor address, and sign-in attempts to 20 per 10 minutes.
- Opening hours can be a range, closed, or "open 24 hours" (stored as 00:00 to 24:00). Nothing can run past midnight.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5630 with an in-memory store; the desk password is dev-password
npm test           # the API tests (in-memory store)
npm run test:ui    # browser tests; needs Chrome or `npx playwright install chromium` inside dev/
```

Local runs use `dev/mock-blob.js` in place of Vercel Blob, so nothing touches real data. The `dev/` folder is not deployed.

## Deploy

Pushing to `main` deploys to production automatically. If a push is not picked up, redeploy from the Vercel dashboard.

## Operating notes

- **Reminders** need Resend (see above). If scheduling a reminder fails more than once and nothing repairs it before the 48 hour mark, that reminder is missed, and the desk shows "Not sent" for it.
- **Backups:** there are none yet. The Blob store is the only copy of bookings, receipts, settings and logins.
- **Receipts** contain clients' bank details. They are only served to signed-in logins.
- **Dependencies:** one runtime dependency, `@vercel/blob`. `npm audit` reports a `zod` advisory that arrives through Vercel's own packages and cannot be fixed from here. Do not run `npm audit fix --force`, which would downgrade `@vercel/blob`.
