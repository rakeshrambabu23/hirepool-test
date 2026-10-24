# HirePool update: what changed and how to switch it on

## What is new
1. **Signup asks for the owner's mobile number** (country dropdown, number checked per country). Admin sees it (with a WhatsApp link) in Signup requests and Agencies.
2. **Candidates are deleted automatically.** 7 days after they apply. If the agency moves a candidate to Shortlisted (or Interview / Selected), they get 7 more days, once (14 days in total). Agencies stop seeing a candidate the moment the time is over; the resume file and the row are removed by the hourly cleanup.
3. **Alerts on the agency Dashboard:** job closes today / tomorrow, job past its last date, candidates deleting within 24 hours, subscription ending within 7 days, new applications, drafts, missing logo. Candidates page has an "Auto-delete in" column and a "Deleting within 24h" filter.
4. **Job posts close on their last date** (link stops working, no new applications) **and are deleted automatically** when none of their applicants are left. Jobs that still have applicants stay visible as "Expired" until those applicants are deleted.
5. **Admin: Reactivate asks for the plan again.** The new term starts today. The agency must log in again with its existing access code.
6. **The public application form shows the agency logo and name.** The consent text states the 7 day deletion rule.
7. All dates now use India time (IST), the same as the database.

## Switch it on (about 15 minutes)
**A. Database.** Supabase > SQL Editor > New query > paste `supabase/03_retention_alerts_phone.sql` > Run. (Needs 01 and 02 to be run already. Safe to run twice.)

**B. Cleanup function.** Files can only be removed through the Storage API, so a small Edge Function does the deleting.
1. Supabase > Edge Functions > Deploy a new function > **Via Editor**. Name: `purge-expired`. Paste the whole of `supabase/functions/purge-expired/index.ts`. Deploy.
2. Open the function > settings: turn **Verify JWT OFF** (it is called with a secret header instead).
3. Edge Functions > Secrets > add `CRON_SECRET` = a long random text (30+ characters). Keep a copy for step C.
4. Optional alert e-mails (skip if you do not have an e-mail provider yet): also add `RESEND_API_KEY`, `ALERT_FROM` (for example `HirePool <alerts@yourdomain.com>`) and `SITE_URL`. Without these, only the in-app alerts work.

**C. Schedule it.** Open `supabase/04_schedule_cleanup.sql`, replace `YOUR-PROJECT-REF` and `YOUR-LONG-RANDOM-CRON-SECRET` (same text as CRON_SECRET), then run it once in the SQL Editor. It runs every hour.

**D. Website files.** Upload the changed files to Cloudflare Pages (all of them, folder structure as in the zip), then hard refresh (Ctrl+Shift+R). Do this AFTER step A: a cached old signup page would fail once the database requires a phone number.

## Test it (10 minutes)
1. Sign up a test agency: invalid number is refused, a valid number goes through; admin sees the number.
2. Apply to a job as a candidate. In SQL Editor: `update public.candidates set expires_at = now() - interval '1 minute' where email = 'YOUR-TEST-EMAIL';`
   The candidate disappears from the agency list at once. Run the function now (SQL Editor, replace both values): 
   `select net.http_post(url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/purge-expired', headers := '{"x-cron-secret":"YOUR-LONG-RANDOM-CRON-SECRET"}'::jsonb);`
   Then check Storage > resumes (file gone) and `select count(*) from public.candidates where email = 'YOUR-TEST-EMAIL';` (0). Or wait for the hourly run.
3. Shortlist a candidate: the drawer shows the deadline moved by 7 days and says "already extended once". Moving it back and forth does not add more time.
4. Create a job with last date = tomorrow: the dashboard shows the "closes tomorrow" alert. Set the date to yesterday in SQL to see "Expired".
5. Admin: Suspend an agency, then Reactivate: the plan dialog appears and shows the new term (today to today + months).
6. Open a job link: the agency logo is shown (upload a logo first from the sidebar).
7. If something does not run: `select * from cron.job_run_details order by start_time desc limit 5;` and `select status_code, content from net._http_response order by created desc limit 5;`

## Things to know
- **The cleanup must run, or resume files stay in storage** after the deadline (agencies cannot see them any more, but the files exist). Check step 7 above after setup.
- Time rule used: "another 7 days" = original deadline + 7 days, only once. Interview and Selected count like Shortlisted for this. Rejected or untouched candidates are deleted at day 7.
- The signup number rules in the browser cover India, the Gulf countries and about 15 more. The database only checks that it is a well-formed international number. Use "Other country" for the rest.
- Alert e-mails are written and tested against a fake mail service, **not against real Resend**. Try with your own agency account first.
- Candidates and resume files deleted by the cleanup cannot be recovered.
