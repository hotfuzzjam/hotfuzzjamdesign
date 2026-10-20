# HOTFUZZJAM Studio — site + booking

Static landing page (`index.html` + `assets/`) with a Supabase back end for accounts, bookings,
the public roster, confirmation emails and 24-hour reminders.

Until `CONFIG` in `index.html` is filled in, the page runs in **preview mode**: sample bookings,
local sign-in, no emails. A "Preview mode" chip shows in the nav so nobody mistakes it for live.

## What you need
- A Supabase project (free tier is fine)
- A Resend account with your sending domain verified (e.g. `hotfuzzjam.com.au`)
- The Supabase CLI (`npm i -g supabase`) — or use the dashboard for each step

## Setup — about 20 minutes

1. **Database.** Run `supabase/migrations/20261020000000_hotfuzzjam_booking.sql` in the SQL editor
   (or `supabase link --project-ref <ref> && supabase db push`).
   This creates rooms, profiles, bookings, the double-booking constraint, `get_roster` and `cancel_booking`.

2. **Auth.** Dashboard → Authentication → URL configuration: set Site URL to your live domain and add it
   to Redirect URLs. Email + password and magic links are both used by the page.
   Optional: Authentication → Emails → set custom SMTP to Resend so auth emails come from your domain.

3. **Function secrets.**
   ```
   supabase secrets set RESEND_API_KEY=re_xxx \
     MAIL_FROM="HOTFUZZJAM Studio <bookings@hotfuzzjam.com.au>" \
     STUDIO_ADDRESS="<street address>, Gold Coast QLD" \
     ARRIVAL_NOTE="Door code 0000. Arrive 10 minutes early to load in. Pay on arrival." \
     SITE_URL="https://hotfuzzjam.com.au" \
     CRON_SECRET="<long random string>"
   ```

4. **Deploy functions.**
   ```
   supabase functions deploy booking-notify
   supabase functions deploy send-reminders --no-verify-jwt
   ```

5. **Hourly reminders.** Edit and run `supabase/cron.sql` (same secret as `CRON_SECRET`).

6. **Connect the page.** In `index.html`, set `CONFIG.SUPABASE_URL` and `CONFIG.SUPABASE_ANON_KEY`
   (Dashboard → Project Settings → API). The anon key is safe in the browser; RLS does the protecting.

7. **Deploy** the folder to any static host (Netlify, Vercel, Cloudflare Pages).

## Change before launch
- **Rate, room size, capacity:** `ROOMS` in `index.html` (one room, `id: 'a'`) and the `insert into public.rooms` in the migration. Current values ($40/hr, 6 × 5 m) are placeholders.
- **Hours / max session length:** `OPEN`, `CLOSE`, `MAX_HOURS` in `index.html` and `validate_booking()` in the migration. Keep them in sync.
- **Contact email + Instagram:** footer of `index.html`.

## How the guarantees work
- **No double bookings:** a Postgres exclusion constraint rejects overlapping confirmed bookings for the room, even if two people press Confirm at the same moment. The page shows a friendly message on that error.
- **Privacy:** the roster comes from `get_roster()`, which returns times only. Bookers can read only their own rows.
- **Rules enforced server-side:** on-the-hour starts, 1–4 hours, 10:00–23:00 Gold Coast time, 60 days ahead, no past bookings.
- **Emails:** confirmation is sent the moment a booking is made; the hourly job retries any missed confirmation and sends reminders 24 hours out. Every email carries an `.ics` calendar file with a 2-hour alarm.
