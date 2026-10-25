# HirePool setup (Supabase + Cloudflare Pages only)

No Node.js, no npm, no build step, no Worker, no R2.

| Part | What it does |
|---|---|
| Supabase Auth | Agency and admin login, email verification, password reset |
| Supabase PostgreSQL | agencies, jobs, candidates, notes. Protected by Row Level Security (RLS) |
| Supabase Storage | Private `resumes` bucket (PDF only, 20 MB) and public `logos` bucket |
| Cloudflare Pages | Hosts the static website files |

Time needed: about 30 minutes.

## Step 1. Supabase database

1. Supabase Dashboard > **SQL Editor > New query**.
2. If you have NOT already run it: paste `supabase/01_schema.sql` > **Run**. (If you already did, skip it.)
3. New query: paste `supabase/02_migration_supabase_only.sql` > **Run**. It is safe to run twice. It does not delete tables.
   It creates the private `resumes` bucket, the public `logos` bucket, all Storage policies, and the public-application functions.
4. **Storage** (left menu): you should see `resumes` (Private) and `logos` (Public). `resumes` must NOT say Public.
5. **Project Settings > API**: copy the Project URL and the **anon / publishable** key. Do NOT copy the service_role / secret key anywhere.
6. Open `js/config.js` and paste only those two values.

> If you tested the old R2/Worker version: old candidates stay in the database, but their resumes lived in R2 and cannot be opened.
> Delete your test jobs, or ignore them.

## Step 2. Supabase Authentication

1. **Authentication > Sign In / Providers > Email**: "Confirm email" ON. Minimum password length 8.
2. **Authentication > URL Configuration**
   - **Site URL**: your final address, e.g. `https://hirepool.pages.dev` (use `http://localhost:8080` while testing locally).
   - **Redirect URLs**, add each of these (and the localhost versions while testing):
     - `https://YOUR-SITE.pages.dev/index.html`
     - `https://YOUR-SITE.pages.dev/reset.html`
3. **Create the platform admin (you):** Authentication > Users > Add user > Create new user, tick **Auto Confirm User**. Then SQL Editor:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'YOU@EXAMPLE.COM';
   ```
4. **Email sending:** Supabase's built-in sender allows only a few emails per hour. Before launch add SMTP (Resend, Brevo or Amazon SES) under Authentication > Emails > SMTP Settings.
5. **Storage limit:** Project Settings > Storage: the global file size limit must be 20 MB or more (free plan allows up to 50 MB).

## Step 3. Run locally (optional, no Node needed)

Use any static preview: the VS Code "Live Server" extension, or in a terminal `python3 -m http.server 8080` inside the `hirepool` folder.
Open `http://localhost:8080`. Add `http://localhost:8080/index.html` and `/reset.html` to the Supabase Redirect URLs.

## Step 4. Deploy to Cloudflare Pages (no build command)

1. Cloudflare dashboard > **Workers & Pages > Create > Pages > Upload assets** (or connect a Git repo).
2. Upload the `hirepool` folder contents: all `.html` files, `css/`, `js/`, and `_headers`.
   You may leave out `supabase/` and `SETUP.md`.
3. If you connect Git instead: **Framework preset: None. Build command: leave empty. Build output directory: `/`**.
4. You get `https://YOUR-SITE.pages.dev`. Go back to Step 2 and make sure Site URL and Redirect URLs use exactly this address.
   (Custom domain later? Update Step 2 again.)

## Step 5. How the main flows are secured

- **Agency access code is checked by the database**, not only by JavaScript. After login the agency must redeem its code; the database remembers that login session. Without it, RLS returns no jobs, candidates or resumes. Agencies cannot read the code column through the API. A new code or suspension ends their sessions immediately.
- **Resumes** live in the private bucket at `<agency_id>/<job_id>/<candidate_id>.pdf`. Storage RLS lets an agency read or delete only files in its own folder. The browser asks Supabase for a 5-minute signed link; Supabase refuses if the policy does not allow it. Nobody can overwrite files (there is no UPDATE policy).
- **Public applicants (no account):** the browser calls `submit_application()`. The database validates every field (job open, position valid, consent, email, phone) and returns ONE exact upload path. The Storage policy allows an anonymous upload only to that path, only while the application is pending (30 minutes), and only once. Then `finalize_application()` confirms the file arrived and records its true size from Storage metadata. Unfinished applications are invisible to agencies.
- **Admin:** only users listed in `public.admins` can call the `admin_*` functions. Changing browser variables cannot grant this. The admin sees counts and storage totals but cannot open resumes.
- Suspended or expired agencies lose data access immediately, and their public job links stop accepting applications.

## Step 6. Test checklist

| # | Test | Expected |
|---|---|---|
| 1 | Sign up an agency, click the email link, log in as admin and approve, copy the access code, log in as the agency with email + password + code, log out | Works. Wrong code shows "Invalid email, password or access code." |
| 2 | Login page > Forgot password > open the email link | `reset.html` shows the new-password form; the new password works |
| 3 | Create a job, then Save as draft, then Publish | Draft has no link; published job shows a link |
| 4 | Open the application link in an incognito window | Form loads. A closed/draft job link shows "closed or invalid" |
| 5 | Apply with a valid PDF under 20 MB | "Application submitted"; candidate appears in the agency dashboard |
| 6 | Try a .txt, a renamed non-PDF, and a PDF over 20 MB | Each rejected with a clear message |
| 7 | Candidate drawer > View resume / Download | PDF opens in a new tab / downloads. The link stops working after 5 minutes |
| 8 | Second agency account: open the first agency's candidate id or resume link | Nothing found / link refused (RLS) |
| 9 | Agency user opens `admin.html` | Sent back to login: "This account is not a platform admin." |
| 10 | In the browser console as an agency user run `await sb.rpc("admin_stats")` | Error: `forbidden` |
| 11 | Site works with no Node/build | Yes: static files only |
| 12 | Search all files for `service_role` / secret keys; in Storage, confirm `resumes` is Private | None found; Private |
| 13 | Log in as agency, admin clicks "New code" | Agency's next page load asks to log in again with the new code |
| 14 | Delete a candidate / delete a job | Rows and PDF files disappear (check Storage > resumes) |

## Remaining limitations and production blockers (please read)

1. **Spam on the public form cannot be fully stopped without a trusted server.** Anyone who knows an open job link can submit applications. The database throttles (max 300 applications per job per hour, 5 per email per hour, one per email per position) but there is **no CAPTCHA**, and a determined attacker with many emails can still fill the job with junk or use storage up to the 20 MB per file limit. Simplest upgrade: a free Supabase Edge Function that verifies a Cloudflare Turnstile token (this is still Supabase, but it needs deploying via the Supabase dashboard/CLI). Until then, only publish links to people you trust (WhatsApp groups etc.) and close jobs promptly.
2. **File type is checked by the browser and the bucket's MIME-type setting, not by reading the file's bytes on a server.** A malicious applicant who bypasses the form could upload a non-PDF labelled as a PDF. It is stored privately and served as `application/pdf`, so browsers will not run it, but there is no antivirus scan. Tell agencies to open resumes with a normal up-to-date PDF viewer.
3. **Abandoned uploads leave orphan files** (a file whose application was never finalized). They are invisible but use storage. Clean up occasionally (Storage > resumes) or schedule it with pg_cron later. The admin storage figure includes them.
4. **Email sending:** the built-in Supabase sender is for testing only. Add SMTP before launch.
5. **Supabase free plan** pauses inactive projects and has no automatic backups. Move to Pro before real agencies pay you. Storage on free is 1 GB total.
6. **Privacy pages:** Privacy policy, Terms and Data deletion are still footer text. You store personal data (resumes), so add real pages and a deletion process before launch.
7. **Admin lists and agency candidate lists load in pages of 1000 rows** (the admin list loads up to 1000 agencies). Fine for early stage.
8. **Obsolete files:** the Cloudflare Worker (`worker/index.js`, `worker/wrangler.toml`) is no longer used by any page. You can delete the `worker/` folder and any R2 bucket you created. Nothing in the site calls it any more.

---

# Update 03: mobile number, 10-day auto-delete, SEO

## A. Database (do this first)
1. Supabase > SQL Editor > New query: paste `supabase/03_migration_retention_and_phone.sql` > **Run**. Safe to run twice.
2. If the last block prints a notice about `pg_cron`: Database > Extensions > enable **pg_cron**, then run the migration again.
3. Jobs that already exist get a fresh 10 days from the moment you run it, so nothing disappears by surprise.

## B. What changed
- **Signup** asks for a mobile number (country dropdown + per-country check). Saved on the agency, shown in the admin tables.
- **Job posts auto-delete 10 days after posting**, together with their candidates, notes and resume PDFs. Editing, closing or reopening a post does not extend it, and agencies cannot change the date.
- From 3 days before deletion the agency Dashboard shows an alert per post with a **Download shortlisted** button (ZIP: `shortlisted.csv` + resume PDFs). The same button is on every card on the Jobs page. "Shortlisted" means status Shortlisted, Interview or Selected.
- Expired posts stop accepting applications immediately.
- Change the number of days: both `'10 days'` in the migration (then run it again) and `RETENTION_DAYS` in `js/data.js`.

## C. How the deletion runs
- Rows are removed by `purge_expired_jobs()`, every 30 minutes (pg_cron) and also whenever an agency or the admin opens a page.
- Supabase blocks deleting files from SQL, so the resume files are queued in `purge_files` and removed by the next agency or admin page load through the Storage API. If an agency never logs in again, the admin page load clears their files. Open `admin.html` now and then.

## D. SEO
1. In `index.html`, `signup.html`, `robots.txt` and `sitemap.xml` replace `https://YOUR-DOMAIN.com` with your real address (no trailing slash).
2. Upload the new `robots.txt`, `sitemap.xml`, `favicon.svg`, `og-image.png` next to `index.html`.
3. Google Search Console > add your site > Sitemaps > submit `sitemap.xml`.
4. Login, dashboard, admin, apply and reset pages are `noindex` (meta tag and `_headers`). Only the home and signup pages are indexed.
