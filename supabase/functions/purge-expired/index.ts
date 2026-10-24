// HirePool cleanup, runs every hour (see 04_schedule_cleanup.sql).
//  1) deletes candidates whose time is over (resume file first, then the row)
//  2) deletes unfinished uploads older than 1 day
//  3) deletes job posts whose last date has passed AND that have no applicants left
//  4) OPTIONAL once a day per agency: alert e-mail (only if RESEND_API_KEY and ALERT_FROM are set)
// Deploy in: Supabase Dashboard > Edge Functions > Deploy a new function > "Via Editor". Turn "Verify JWT" OFF.
// Function secrets needed: CRON_SECRET (long random text). Optional: RESEND_API_KEY, ALERT_FROM, SITE_URL.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";

const IST_MS = 330 * 60 * 1000;
const istDate = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// deno-lint-ignore no-explicit-any
export async function run(sb: any, env: Record<string, string | undefined>, fetchFn: typeof fetch, now = new Date()) {
  const out = { candidates: 0, files: 0, jobs: 0, emails: 0, errors: [] as string[] };
  const nowIso = now.toISOString();
  const today = istDate(now);

  // Delete a batch of candidates: files FIRST through the Storage API, rows only if the files are gone.
  // deno-lint-ignore no-explicit-any
  const purge = async (label: string, query: () => any) => {
    for (let round = 0; round < 10; round++) {
      const { data, error } = await query();
      if (error) { out.errors.push(`${label} select: ${error.message}`); return; }
      if (!data || !data.length) return;
      const paths = data.map((r: { resume_key: string | null }) => r.resume_key).filter(Boolean);
      if (paths.length) {
        const rm = await sb.storage.from("resumes").remove(paths);
        if (rm.error) { out.errors.push(`${label} remove files: ${rm.error.message}`); return; }
        out.files += paths.length;
      }
      const del = await sb.from("candidates").delete().in("id", data.map((r: { id: string }) => r.id));
      if (del.error) { out.errors.push(`${label} delete rows: ${del.error.message}`); return; }
      out.candidates += data.length;
      if (data.length < 200) return;
    }
  };
  await purge("expired", () => sb.from("candidates").select("id,resume_key").lte("expires_at", nowIso).limit(200));
  await purge("abandoned", () => sb.from("candidates").select("id,resume_key").eq("resume_uploaded", false)
    .lt("created_at", new Date(now.getTime() - 24 * 3600e3).toISOString()).limit(200));

  // Job posts past their last date and with no applicants left (done inside the database, in one safe statement)
  const pj = await sb.rpc("purge_expired_jobs");
  if (pj.error) out.errors.push("jobs: " + pj.error.message); else out.jobs = Number(pj.data) || 0;

  // Optional daily alert e-mail, from 08:00 India time, at most one per agency per day
  const istHour = new Date(now.getTime() + IST_MS).getUTCHours();
  if (env.RESEND_API_KEY && env.ALERT_FROM && istHour >= 8) {
    try {
      const done = await sb.from("alert_log").select("agency_id").eq("day", today);
      const skip = new Set((done.data || []).map((r: { agency_id: string }) => r.agency_id));
      const ags = await sb.from("agencies").select("id,name,email,expires").eq("status", "Active");
      const tomorrow = addDays(today, 1), in24h = new Date(now.getTime() + 24 * 3600e3).toISOString();
      for (const a of (ags.data || [])) {
        if (skip.has(a.id)) continue;
        const jobs = await sb.from("jobs").select("heading").eq("agency_id", a.id).eq("status", "Open").eq("deadline", tomorrow);
        const cands = await sb.from("candidates").select("id", { head: true, count: "exact" }).eq("agency_id", a.id).eq("resume_uploaded", true).gt("expires_at", nowIso).lte("expires_at", in24h);
        const lines: string[] = [];
        for (const j of (jobs.data || [])) lines.push(`Job post "${esc(j.heading)}" closes tomorrow (${tomorrow}).`);
        if ((cands.count || 0) > 0) lines.push(`${cands.count} candidate(s) will be deleted automatically within 24 hours. Download the resumes you need, or shortlist them to keep them 7 more days (once).`);
        if (a.expires && a.expires >= today && a.expires <= addDays(today, 3)) lines.push(`Your subscription ends on ${esc(a.expires)}. Contact sales to renew.`);
        let sent = false;
        if (lines.length) {
          const html = `<p>Hello ${esc(a.name)},</p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>${env.SITE_URL ? `<p><a href="${esc(env.SITE_URL)}">Open HirePool</a></p>` : ""}`;
          const res = await fetchFn("https://api.resend.com/emails", { method: "POST",
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: env.ALERT_FROM, to: [a.email], subject: `HirePool alerts for ${today}`, html }) });
          if (!res.ok) { out.errors.push(`email ${a.id}: HTTP ${res.status}`); continue; }  // not logged, retried next hour
          sent = true; out.emails++;
        }
        await sb.from("alert_log").insert({ agency_id: a.id, day: today, sent });
      }
    } catch (e) { out.errors.push("alerts: " + (e as Error).message); }
  }
  return out;
}

const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

// @ts-ignore Deno exists inside Supabase Edge Functions
if (typeof Deno !== "undefined") Deno.serve(async (req: Request) => {
  // @ts-ignore
  const env = (k: string) => Deno.env.get(k);
  const secret = env("CRON_SECRET") || "";
  if (!secret || !same(req.headers.get("x-cron-secret") || "", secret)) return new Response("unauthorized", { status: 401 });
  let key = env("SUPABASE_SERVICE_ROLE_KEY") || "";
  try { key = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default || key; } catch (_) { /* keep legacy key */ }
  const sb = createClient(env("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  const result = await run(sb, { RESEND_API_KEY: env("RESEND_API_KEY"), ALERT_FROM: env("ALERT_FROM"), SITE_URL: env("SITE_URL") }, fetch);
  return new Response(JSON.stringify(result), { status: result.errors.length ? 207 : 200, headers: { "content-type": "application/json" } });
});
