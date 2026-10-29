-- Scheduled jobs (already applied to the hotfuzzjam-studio project as migration "schedule_jobs").
-- To recreate on another project: replace <PROJECT_REF>, then run once in the SQL editor
-- AFTER deploying send-reminders and applying 20261030000000_hardening_and_cron.sql.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The cron secret is generated inside the database and never copied anywhere:
-- pg_cron sends it, and send-reminders checks it with public.cron_secret_ok().
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'hfj_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'hfj_cron_secret', 'x-cron-secret for the send-reminders function');
  end if;
end $$;

-- emails, SMS, follow-ups, waitlist (every 10 minutes)
select cron.schedule('hfj-send-reminders', '*/10 * * * *', $job$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json',
               'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hfj_cron_secret')),
    body    := '{}'::jsonb);
$job$);

-- release unpaid slot holds quickly (every 5 minutes, pure SQL)
select cron.schedule('hfj-expire-holds', '*/5 * * * *', $job$ select public.expire_holds(); $job$);

-- To check:   select * from cron.job_run_details order by start_time desc limit 10;
-- To remove:  select cron.unschedule('hfj-send-reminders'); select cron.unschedule('hfj-expire-holds');
