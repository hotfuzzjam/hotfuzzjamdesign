-- Run once in the Supabase SQL editor AFTER deploying the send-reminders function.
-- Replace <PROJECT_REF> and <LONG_RANDOM_SECRET> (use the same secret as the CRON_SECRET function secret).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<LONG_RANDOM_SECRET>', 'hfj_cron_secret');

select cron.schedule(
  'hfj-send-reminders',
  '7 * * * *',  -- every hour at :07
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hfj_cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check:   select * from cron.job_run_details order by start_time desc limit 10;
-- To remove:  select cron.unschedule('hfj-send-reminders');
