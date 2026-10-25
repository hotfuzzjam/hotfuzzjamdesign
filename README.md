# HOTFUZZJAM Studio — site, booking and studio admin

- `index.html`: the public site. Live roster, booking calendar, client accounts, promo codes, gift cards,
  deposit or full payment (Stripe), SMS opt-in, waitlist, and a private change/cancel link for every booking.
- `admin.html`: the owner dashboard. Overview, bookings (mark paid, cancel and refund, resend), phone and walk-in bookings,
  block-outs, promo codes, gift cards, waitlist, clients and settings.
- `supabase/`: database migrations and edge functions.

Until `CONFIG` is filled in **in both HTML files**, they run in **preview mode**: sample data, local sign-in,
simulated checkout, no emails, no charges. A "Preview" chip shows so nobody mistakes it for live.
Preview codes to try: promo `LOUD10` (10% off), `FIRSTJAM` ($20 off, 2+ hours), gift card `HFJ-DEMO-GIFT` ($50).

## Accounts you need
| Service | For | Cost |
| --- | --- | --- |
| Supabase | Database, sign-in, server functions, scheduled jobs | Free tier is fine |
| Stripe | Online payments, deposits, refunds, gift card sales | 1.7% + 30c per domestic card |
| Resend | Confirmation, reminder, follow-up, waitlist and gift emails | Free up to 3,000 emails a month |
| Twilio (optional) | SMS reminders | About 6–8c AUD per text, plus a number |

## Setup (about 40 minutes)

1. **Database.** Apply both migrations in order (`supabase link --project-ref <ref> && supabase db push`, or paste each
   file into the SQL editor):
   `20261020000000_hotfuzzjam_booking.sql`, then `20261025000000_scheduling_suite.sql`.

2. **Make yourself the admin.** Create your account on the site (Sign in → Create account), then in the SQL editor:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@hotfuzzjam.com';
   ```

3. **Auth.** Dashboard → Authentication → URL configuration: Site URL `https://hotfuzzjam.com`, and add it to Redirect URLs.
   Optional: Authentication → Emails → custom SMTP through Resend, so sign-in emails come from your domain.

4. **Stripe.** Use test mode first.
   - Developers → API keys → copy the secret key.
   - Developers → Webhooks → Add endpoint `https://<ref>.supabase.co/functions/v1/stripe-webhook`,
     events `checkout.session.completed` and `checkout.session.expired`. Copy the signing secret.

5. **Function secrets.**
   ```
   supabase secrets set \
     SITE_URL="https://hotfuzzjam.com" \
     RESEND_API_KEY=re_xxx MAIL_FROM="HOTFUZZJAM Studio <bookings@hotfuzzjam.com>" \
     STUDIO_ADDRESS="<street address>, Gold Coast QLD" \
     ARRIVAL_NOTE="Door code 0000. Arrive 10 minutes early to load in." \
     STRIPE_SECRET_KEY=sk_test_xxx STRIPE_WEBHOOK_SECRET=whsec_xxx \
     CRON_SECRET="<long random string>"
   # optional, for SMS:
   supabase secrets set TWILIO_ACCOUNT_SID=ACxxx TWILIO_AUTH_TOKEN=xxx TWILIO_FROM=+61xxxxxxxxx
   ```
   No Stripe key yet? Bookings still work: everything is "pay at the studio" until the key is set.

6. **Deploy functions** (JWT settings come from `supabase/config.toml`):
   ```
   supabase functions deploy create-checkout admin-action stripe-webhook buy-gift manage-booking send-reminders
   ```

7. **Scheduled jobs.** Edit and run `supabase/cron.sql`: reminders, SMS, follow-ups and waitlist emails every 10 minutes,
   and unpaid holds released every 5 minutes.

8. **Connect the pages.** In `index.html` and `admin.html`, set `CONFIG.SUPABASE_URL` and `CONFIG.SUPABASE_ANON_KEY`
   (Project Settings → API). The anon key is safe in the browser: row-level security does the protecting.

9. **Settings.** Open `/admin.html` → Settings: hourly rate, hours, deposit %, payment mode, cancellation window, SMS on/off.

## How it behaves
- **Pricing is server-side.** `create-checkout` recomputes rate × hours − promo code − gift card. The browser's numbers are only a preview.
- **Holding a slot while paying.** A booking awaiting payment holds its slot for 30 minutes (Stripe's minimum), then is released by the webhook or the 5-minute job. If payment lands after the slot was lost, it's refunded automatically.
- **Change or cancel.** Every email carries a private link (`/?manage=<token>`). Free changes and refunds up to the cutoff (default 24 hours); inside it, cancelling is allowed but online payments aren't refunded. Three moves per booking.
- **Gift cards.** Sold without an account. Activated by the webhook, emailed to the recipient with a receipt to the buyer. The balance carries over, and is restored if a booking is cancelled in time.
- **Waitlist.** Clients pick a window on a day. When a slot of the length they need opens (cancellation, move or expired hold), they're emailed once.
- **No double bookings.** A Postgres exclusion constraint covers confirmed and awaiting-payment bookings; block-outs are checked by the booking trigger.
- **Privacy.** The public roster shows times only. Clients see only their own bookings and waitlist entries; the admin role sees everything.

## Before launch
- Placeholders: $40/hr and 6 × 5 m in `ROOMS` (`index.html`); the rate is also in Settings, which wins once Supabase is connected.
- Contact email and Instagram link in the footer.
- Run one real booking in Stripe test mode end to end, including a cancel with refund, before switching to live keys.
