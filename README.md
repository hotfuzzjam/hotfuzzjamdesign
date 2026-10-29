# HOTFUZZJAM Studio — site and bookings

The site is a single static page (`index.html`) on Netlify. Bookings, payments, reminders, changes, cancellations
and gift vouchers run on **Acuity Scheduling**; the page embeds Acuity's scheduler and links to its store.

Until the Acuity links are filled in, the booking panel shows an "email us to book" fallback and the gift button
opens an email.

## Connect Acuity (two links)

At the top of the page script, in `CONFIG`:

```js
const CONFIG = {
  ACUITY_SCHEDULE: 'https://app.acuityscheduling.com/schedule.php?owner=XXXXXXXX&appointmentType=NNNNNNN',
  ACUITY_STORE:    '<direct link to your Acuity store page>'
};
```

- **ACUITY_SCHEDULE**: Acuity › Scheduling Page › Link (Share & Embed) › copy the embed code. Its iframe `src` is this link.
  Adding `&appointmentType=` with the room's ID opens the calendar straight on the room.
  If the embed code's `<script src>` differs from `https://embed.acuityscheduling.com/js/embed.js`, update it in `mountAcuity()`.
- **ACUITY_STORE**: the direct link to the store page where gift certificates are sold.

## Acuity setup checklist

1. **Plan.** Standard or higher (gift certificates and SMS reminders are not on Starter). Premium adds API access,
   which the weekly roster needs, plus custom CSS and removing Acuity branding.
2. **Business hours and time zone.** Australia/Brisbane, 10:00 – 23:00, seven days.
3. **Appointment type "The Room".** Hourly; offer 1, 2, 3 and 4 hours (one type per length, or one type with add-ons),
   $40 per hour incl. GST. Buffer between sessions if you want changeover time.
4. **Payments.** Connect Stripe, Square or PayPal and require payment at booking (or a deposit).
5. **Scheduling limits.** Book up to 60 days ahead; clients can reschedule or cancel up to 24 hours before.
6. **Emails.** Put the street address, door code and arrival note ("Arrive 10 minutes early to load in") in the
   confirmation email. Turn on the reminder email (and SMS) the day before, and a follow-up after the session.
7. **Gift certificates.** Create them (for example $40, $80, $160, $300), set to Public.
8. **Coupons.** Recreate any promo codes, such as LOUD10 for 10% off.
9. **Appearance.** Logo, and set the scheduler's accent colour to the site's purple (#5A3460) so the embedded calendar matches.
10. **Intake form.** Ask for band or project name and notes for the studio.

## Roster

The weekly roster section is in the page but hidden (`<section id="roster" hidden>`). Showing live availability needs
Acuity's API (Premium plan) and a small serverless function that keeps the API key private. Wire it up later.

## Retired

The custom Supabase + Stripe booking system (database migrations, edge functions, `admin.html`) is no longer deployed.
`/admin.html` redirects to the Acuity login. The source is kept in the repository history if it's ever needed again.
