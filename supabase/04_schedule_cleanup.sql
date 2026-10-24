-- HirePool update 04: run the cleanup Edge Function every hour.
-- Run ONCE, after deploying the "purge-expired" Edge Function and setting its CRON_SECRET secret.
-- 1) Replace YOUR-PROJECT-REF and YOUR-LONG-RANDOM-CRON-SECRET below (the secret must equal the function's CRON_SECRET).
-- 2) SQL Editor > New query > paste > Run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Vault stores these two values encrypted. (If a name already exists, use vault.update_secret instead.)
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/purge-expired', 'hp_purge_url');
select vault.create_secret('YOUR-LONG-RANDOM-CRON-SECRET', 'hp_cron_secret');

select cron.schedule('hirepool-cleanup', '7 * * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'hp_purge_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hp_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$job$);

-- Check later:   select * from cron.job_run_details order by start_time desc limit 5;
--                select id, status_code, content from net._http_response order by created desc limit 5;
-- Stop it:       select cron.unschedule('hirepool-cleanup');
