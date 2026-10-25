// HirePool data layer: Supabase only (Auth + PostgreSQL + Storage). No Worker, no Node.js.
const POSITIONS=["NDT Level II (UT/MT/PT)","NDT Level III","PAUT Inspector","TOFD Technician","RT Film Interpreter","QA/QC Piping Inspector","QA/QC Welding Inspector","Welding Inspector (CSWIP 3.1)","Coating Inspector (NACE/BGAS)","Mechanical Inspector","Static Equipment Inspector (API 510)","Pipeline Inspector (API 570)","Tank Inspector (API 653)","Rope Access Technician","Welding Engineer","Piping Engineer","Mechanical Engineer","HSE Officer","Document Controller","Planner / Scheduler"];
const COUNTRIES=["Kuwait","Qatar","UAE","Saudi Arabia","Oman","Bahrain"],SECTORS=["Oil & Gas","Petrochemical","Power","Construction","Marine"];
const certs=["ASNT Level II UT","ASNT Level II MT","ASNT Level II PT","PAUT Level II","CSWIP 3.1","API 510"];
const sts=["New","Reviewed","Shortlisted","Interview","Selected","Rejected"];
// Job posts (and their candidates) are deleted this many days after posting. Keep in sync with supabase/03_migration_retention_and_phone.sql.
const RETENTION_DAYS=10;
// Candidates counted as "shortlisted" when downloading before a job post is deleted
const SHORTLISTED=["Shortlisted","Interview","Selected"];
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};

const sb=supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
if(/YOUR-/.test(CONFIG.SUPABASE_URL+CONFIG.SUPABASE_ANON_KEY)){
 console.error("HirePool: fill in js/config.js (Supabase URL and anon key).");
 document.addEventListener("DOMContentLoaded",()=>document.body.insertAdjacentHTML("afterbegin",'<div style="background:#fef2f2;color:#991b1b;padding:10px 16px;font:14px sans-serif;position:relative;z-index:99">Setup needed: open <b>js/config.js</b> and add your Supabase URL and anon key.</div>'))}

// In-memory copies of the signed-in agency's data (same shape the screens always used)
let jobs=[],cands=[],accounts=[],profile=null,adminStats={},usage={};

const mapJob=r=>({id:r.id,heading:r.heading,country:r.country,sector:r.sector,positions:r.positions||[],status:r.status,posted:r.posted,urgent:!!r.urgent,deadline:r.deadline||"",desc:r.description||"",expires:r.expires_at||""});
const mapCand=r=>({id:r.id,name:r.name,email:r.email,phone:r.phone,job:r.job_id,position:r.position,exp:Number(r.exp),loc:r.loc||"-",pref:r.pref||"-",certs:r.certs||[],status:r.status,date:String(r.created_at).slice(0,10),size:r.resume_size!=null?Number(r.resume_size).toFixed(1):"0.0",key:r.resume_key||"",hasResume:!!r.resume_key});
const mapAcc=r=>({id:r.id,name:r.name,email:r.email,logo:r.logo_key?sb.storage.from("logos").getPublicUrl(r.logo_key).data.publicUrl:"",status:r.status,code:r.code||"",plan:r.plan,expires:r.expires||"",requested:r.requested,phone:r.phone||""});

// Supabase returns max 1000 rows per request, so read in pages
async function fetchAll(q){const out=[];for(let i=0;;i+=1000){const {data,error}=await q().range(i,i+999);if(error)throw error;out.push(...data);if(data.length<1000)break}return out}

// Returns "" when the signed-in user may open this area, otherwise a message to show on the login page.
async function boot(role){
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 let {data:{session}}=await sb.auth.getSession();
 if(!session){await wait(500);({data:{session}}=await sb.auth.getSession())}   // one retry: the saved session can be a moment late after a refresh
 if(!session)return "Please sign in.";
 if(role=="admin"){
  // Only an explicit "false" from the database means "not an admin". Errors never log the admin out; they show a reload message instead.
  for(let i=0;i<2;i++){
   const {data,error}=await sb.rpc("is_admin");
   if(!error&&data===true)return "";
   if(!error&&data===false&&i==1)return "This account is not a platform admin.";
   if(i==0)await wait(500)}
  throw new Error("Could not verify admin access. Please reload the page.")}
 const {data:a,error}=await sb.from("agencies").select("id,name,email,logo_key,status,plan,expires,requested").eq("user_id",session.user.id).maybeSingle();
 if(error)throw error;
 if(!a)return "No agency account found for this login.";
 if(a.status!="Active")return a.status=="Pending"?"Your signup is under review. You will receive an access code after approval.":"This account is not active. Please contact support.";
 if(a.expires<today())return "Your subscription has expired. Contact sales to renew.";
 // The access code is enforced by the database: this is true only after redeem_access_code() succeeded for this login.
 const {data:ok}=await sb.rpc("session_ok");if(!ok)return "Please sign in again with your access code.";
 profile=mapAcc(a);return ""}

// ---- Resume helpers (private Storage bucket "resumes"; access is decided by Storage RLS policies) ----
const RESUME_BUCKET="resumes";
// Short-lived signed link. Supabase only signs it if the Storage policy lets THIS user read the file.
async function resumeUrl(path,download){
 const {data,error}=await sb.storage.from(RESUME_BUCKET).createSignedUrl(path,300,download?{download:true}:undefined);
 if(error||!data?.signedUrl)throw new Error("Could not open the resume. It may have been deleted, or you may not have access.");
 return data.signedUrl}
// Delete files in small batches. Storage RLS only lets an agency delete files inside its own folder.
async function deleteResumes(paths){
 const list=paths.filter(Boolean);
 for(let i=0;i<list.length;i+=100){const {error}=await sb.storage.from(RESUME_BUCKET).remove(list.slice(i,i+100));if(error)throw error}}

async function loadAgencyData(){
 const [j,c]=await Promise.all([
  fetchAll(()=>sb.from("jobs").select("*").gt("expires_at",new Date().toISOString()).order("created_at",{ascending:false}).order("id")),
  fetchAll(()=>sb.from("candidates").select("id,job_id,name,email,phone,position,exp,loc,pref,certs,status,resume_key,resume_size,resume_uploaded,created_at").order("created_at",{ascending:false}).order("id"))]);
 jobs=j.map(mapJob);const live=new Set(jobs.map(x=>x.id));cands=c.filter(r=>live.has(r.job_id)).map(mapCand)}

// Removes expired job posts in the database, then deletes their queued resume files from Storage.
// Runs in the background after login (agency or admin). Failures are harmless: it simply runs again next time.
async function sweep(){try{
 await sb.rpc("purge_expired_jobs");
 const {data}=await sb.rpc("my_purge_files");const p=data||[];
 if(p.length){await deleteResumes(p);await sb.rpc("clear_purge_files",{p_paths:p})}
}catch(e){console.warn("HirePool clean-up:",e)}}

async function loadAdminData(){
 const [l,st,u]=await Promise.all([sb.rpc("admin_list_agencies"),sb.rpc("admin_stats"),sb.rpc("admin_agency_usage")]);
 for(const r of [l,st,u])if(r.error)throw r.error;
 accounts=l.data.map(mapAcc);adminStats=st.data||{};usage=Object.fromEntries((u.data||[]).map(x=>[x.agency_id,x]))}
