const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const jobName=id=>jobs.find(j=>j.id==id)?.heading||"-",appCount=id=>cands.filter(c=>c.job==id).length;
const go=m=>{if(m)try{sessionStorage.setItem("hp_msg",m)}catch(e){}location.href="index.html"};
const logout=async()=>{try{await sb.auth.signOut()}catch(e){}go()};
const toast=m=>{const t=document.createElement("div");t.className="toast";t.textContent=m;document.body.append(t);setTimeout(()=>t.remove(),2600)};
const fail=e=>{console.error(e);toast(e?.message||"Something went wrong")};
const stat=(l,v)=>`<div class="card stat"><small>${l}</small><div>${v}</div></div>`,badge=s=>`<span class="badge ${esc(s)}">${esc(s)}</span>`;
const linkFor=id=>location.href.split("?")[0].replace(/[^\/]*$/,"")+"apply.html?job="+id;
const waLink=j=>"https://wa.me/?text="+encodeURIComponent(`Hiring: ${j.heading}\nPositions: ${j.positions.slice(0,6).join(", ")}${j.positions.length>6?" and "+(j.positions.length-6)+" more":""}\nApply here: ${linkFor(j.id)}`);
const copy=t=>{navigator.clipboard?.writeText(t);toast("Copied")};
const when=s=>new Date(s).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"});
// ---- Auto-delete helpers: days left, and "download shortlisted" (CSV + resumes in one ZIP) ----
const daysLeft=j=>j.expires?Math.max(0,Math.ceil((new Date(j.expires)-Date.now())/864e5)):RETENTION_DAYS;
const inDays=n=>n<=0?"today":n==1?"in 1 day":`in ${n} days`;
const shortlisted=id=>cands.filter(c=>c.job==id&&SHORTLISTED.includes(c.status));
const csvCell=(v,raw)=>{let s=String(v??"");if(!raw&&/^[=+\-@\t\r]/.test(s))s="'"+s;return'"'+s.replace(/"/g,'""')+'"'};
const safeName=s=>String(s||"").replace(/[^\w\- ]+/g,"").trim().replace(/\s+/g,"_").slice(0,60)||"file";
const saveBlob=(b,n)=>{const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=n;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000)};
const loadZip=()=>window.JSZip?Promise.resolve(window.JSZip):new Promise((ok,no)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";s.onload=()=>window.JSZip?ok(window.JSZip):no(new Error("zip"));s.onerror=()=>no(new Error("zip"));document.head.append(s)});
let dlBusy=false;
async function dlShortlisted(id){
 const j=jobs.find(x=>x.id==id),list=shortlisted(id);
 if(!j)return;if(!list.length)return toast("No shortlisted candidates in this post yet.");
 if(dlBusy)return toast("A download is already running.");dlBusy=true;
 try{
  toast(`Preparing ${list.length} shortlisted candidate${list.length>1?"s":""}...`);
  let zip=null;try{zip=new(await loadZip())()}catch(e){}
  const file=new Map(),used=new Set(),withCv=list.filter(c=>c.hasResume);let i=0,failed=0;
  if(zip){const worker=async()=>{while(i<withCv.length){const c=withCv[i++];try{
   const r=await fetch(await resumeUrl(c.key,false));if(!r.ok)throw new Error("fetch");
   const base=safeName(c.name+"_"+c.position);let k=base,n=1;while(used.has(k))k=base+"_"+(++n);used.add(k);
   zip.file("resumes/"+k+".pdf",await r.blob());file.set(c.id,k+".pdf")}catch(e){failed++}}};
   await Promise.all([worker(),worker(),worker()])}
  const head=["Name","Email","Phone","Position","Experience (yrs)","Current location","Preferred location","Certifications","Status","Applied on","Resume file"];
  const rows=[head,...list.map(c=>[c.name,c.email,c.phone,c.position,c.exp,c.loc,c.pref,c.certs.join("; "),c.status,c.date,file.get(c.id)||""])];
  const csv="\ufeff"+rows.map((r,ri)=>r.map(v=>csvCell(v,ri==0)).join(",")).join("\r\n");
  const nm=safeName(j.heading)+"_shortlisted";
  if(zip){zip.file("shortlisted.csv",csv);saveBlob(await zip.generateAsync({type:"blob"}),nm+".zip")}
  else saveBlob(new Blob([csv],{type:"text/csv"}),nm+".csv");
  toast(!zip?"Downloaded the list only (resume download needs internet access to the zip tool).":failed?`Downloaded. ${failed} resume${failed>1?"s":""} could not be added.`:"Downloaded.")
 }catch(e){fail(e)}finally{dlBusy=false}}
const expiryAlerts=()=>{const soon=jobs.filter(j=>daysLeft(j)<=3).sort((a,b)=>daysLeft(a)-daysLeft(b));
 return soon.map(j=>{const n=daysLeft(j),s=shortlisted(j.id).length;return`<div class="alert${n<=1?" hot":""}"><div><b>${esc(j.heading)}</b> will be deleted ${inDays(n)}, with all ${appCount(j.id)} candidates and resumes.<br><small>${s?`Download your ${s} shortlisted candidate${s>1?"s":""} before it is gone.`:"There are no shortlisted candidates in this post."}</small></div>${s?`<button class="btn sm" onclick="dlShortlisted('${j.id}')">Download shortlisted</button>`:""}</div>`}).join("")
 +`<div class="banner">Job posts and all their candidates are deleted automatically ${RETENTION_DAYS} days after posting. Shortlist the people you want and download them before then.</div>`};
let page=document.body.dataset.page,Q=new URLSearchParams(location.search),stamp=0;
function shell(role,active,title,html){const a=role=="agency"?profile:null;
 const links=role=="admin"?[["admin.html","Overview"]]:[["dashboard.html","Dashboard"],["jobs.html","Jobs"],["candidates.html","Candidates"]];
 if($(".side")&&$(".main")){$$(".side nav a[data-nav]").forEach(l=>l.classList.toggle("on",l.dataset.nav+".html"==active));$(".main").innerHTML=`<div class="top"><h1>${title}</h1><span class="acts" id="acts"></span></div>${html}`;$("#drawer").classList.remove("open");close();window.scrollTo(0,0);return}
 document.body.innerHTML=`<aside class="side"><div class="brand">Hire<b>Pool</b></div><div class="org">${a?.logo?`<img src="${esc(a.logo)}" alt="">`:`<span>${esc((a?.name||"Admin")[0])}</span>`}<b>${esc(a?.name||"Platform admin")}</b></div><nav>${links.map(l=>`<a href="${l[0]}"${role=="agency"?` data-nav="${l[0].slice(0,-5)}"`:""} class="${l[0]==active?"on":""}">${l[1]}</a>`).join("")}${role=="agency"?`<a href="#" onclick="pickLogo();return false">Upload logo</a>`:""}<a href="#" onclick="logout();return false">Logout</a></nav></aside><main class="main"><div class="top"><h1>${title}</h1><span class="acts" id="acts"></span></div>${html}</main><div class="drawer" id="drawer"></div><div class="modal" id="modal"></div>`}
const close=()=>$("#modal").classList.remove("open");
// Agency logo: uploaded after login into the public "logos" bucket, inside this agency's own folder.
function pickLogo(){const i=document.createElement("input");i.type="file";i.accept="image/png,image/jpeg";
 i.onchange=async()=>{const f=i.files[0];if(!f)return;
  if(!/^image\/(png|jpeg)$/.test(f.type)||f.size>512000)return toast("Logo must be a PNG or JPG under 500 KB.");
  try{const key=profile.id+"/logo-"+Date.now()+(f.type=="image/png"?".png":".jpg");
   const {error}=await sb.storage.from("logos").upload(key,f,{contentType:f.type,upsert:false});if(error)throw error;
   const r=await sb.rpc("set_my_logo",{p_key:key});if(r.error)throw r.error;
   toast("Logo updated");setTimeout(()=>location.reload(),600)}catch(e){fail(e)}};i.click()}
const fmtB=b=>{b=Number(b)||0;return b>=1073741824?(b/1073741824).toFixed(2)+" GB":b>=1048576?(b/1048576).toFixed(1)+" MB":Math.round(b/1024)+" KB"};
function openCreate(after,job){let edited=false;
 $("#modal").innerHTML=`<div class="card"><h2>${job?"Edit":"Create"} job post</h2>
 <div class="two"><div><label>Country</label><select id="jc">${COUNTRIES.map(c=>`<option>${esc(c)}</option>`).join("")}<option value="__other">Other...</option></select><input id="jco" placeholder="Type country / location" style="display:none;margin-top:6px"></div><div><label>Sector</label><select id="js">${SECTORS.map(c=>`<option>${esc(c)}</option>`).join("")}<option value="__other">Other...</option></select><input id="jso" placeholder="Type sector" style="display:none;margin-top:6px"></div></div>
 <label>Post heading</label><input id="jh" maxlength="120">
 <label>Positions in this post <span id="cn" style="color:var(--mut);font-weight:500"></span></label>
 <div style="display:flex;gap:6px;margin-bottom:8px"><button type="button" class="btn sec sm" id="sa">Select all</button><button type="button" class="btn sec sm" id="sn">Clear</button></div>
 <div class="checks" id="pl">${POSITIONS.map(p=>`<label><input type="checkbox" value="${esc(p)}"> ${esc(p)}</label>`).join("")}</div>
 <div style="display:flex;gap:6px;margin-top:8px"><input id="po" placeholder="Other position (type and press Add)" style="flex:1"><button type="button" class="btn sec sm" id="pa">Add</button></div>
 <div class="two"><div><label>Last date to apply</label><input id="jd" type="date"></div><div><label>&nbsp;</label><span class="checks"><label><input type="checkbox" id="ju"> Mark as urgent</label></span></div></div>
 <label>Description (optional)</label><textarea id="jt" rows="2" maxlength="4000" placeholder="Salary, visa, accommodation, interview date..."></textarea>
 <div class="always"><b>Auto-delete:</b> this post and all its candidates are deleted ${RETENTION_DAYS} days after posting. Download your shortlisted candidates before then.<br><br><b>Always on the form:</b> name, phone, email, experience, locations, skills, resume (PDF), consent. Candidates pick one of the positions above.</div>
 <div class="err" id="je2"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn sec" id="cx">Cancel</button>${!job||job.status=="Draft"?`<button class="btn sec" id="jdr">Save as draft</button>`:""}<button class="btn" id="jsv">${job?(job.status=="Draft"?"Publish":"Save changes"):"Create and get link"}</button></div></div>`;
 $("#modal").classList.add("open");$("#cx").onclick=close;
 const val=(s,o)=>$(s).value=="__other"?$(o).value.trim():$(s).value;
 const head=()=>{if(!edited)$("#jh").value=[val("#jc","#jco"),val("#js","#jso")].filter(Boolean).join(" - ")},cnt=()=>$("#cn").textContent=`(${$$("#pl input:checked").length} selected)`;
 const sync=()=>{$("#jco").style.display=$("#jc").value=="__other"?"block":"none";$("#jso").style.display=$("#js").value=="__other"?"block":"none";head()};
 if(job){const setSel=(sel,oth,v,L)=>{if(L.includes(v))$(sel).value=v;else{$(sel).value="__other";$(oth).value=v}};
  setSel("#jc","#jco",job.country,COUNTRIES);setSel("#js","#jso",job.sector,SECTORS);edited=true;$("#jh").value=job.heading;
  job.positions.forEach(p=>{const ex=$$("#pl input").find(i=>i.value==p);if(ex)ex.checked=true;else $("#pl").insertAdjacentHTML("beforeend",`<label><input type="checkbox" value="${esc(p)}" checked> ${esc(p)}</label>`)});
  $("#jd").value=job.deadline||"";$("#ju").checked=job.urgent;$("#jt").value=job.desc||""}
 sync();cnt();$("#jc").onchange=$("#js").onchange=sync;$("#jco").oninput=$("#jso").oninput=head;$("#jh").oninput=()=>edited=true;$("#pl").onchange=cnt;
 const addPos=()=>{const t=$("#po").value.trim().replace(/\s+/g," ");if(!t)return;if(t.length>80)return $("#je2").textContent="Position name is too long.";
  const ex=$$("#pl input").find(i=>i.value.toLowerCase()==t.toLowerCase());if(ex)ex.checked=true;
  else $("#pl").insertAdjacentHTML("beforeend",`<label><input type="checkbox" value="${esc(t)}" checked> ${esc(t)}</label>`);
  $("#po").value="";$("#je2").textContent="";cnt()};
 $("#pa").onclick=addPos;$("#po").onkeydown=e=>{if(e.key=="Enter"){e.preventDefault();addPos()}};
 $("#sa").onclick=()=>{$$("#pl input").forEach(i=>i.checked=true);cnt()};$("#sn").onclick=()=>{$$("#pl input").forEach(i=>i.checked=false);cnt()};
 const save=async status=>{if($("#po").value.trim())addPos();const h=$("#jh").value.trim(),ps=$$("#pl input:checked").map(i=>i.value),country=val("#jc","#jco"),sector=val("#js","#jso"),er=m=>$("#je2").textContent=m;
  if(!country)return er("Type the country / location.");if(!sector)return er("Type the sector.");
  if(!h)return er("Enter a heading.");if(!ps.length)return er("Select at least one position.");if(ps.length>60)return er("Maximum 60 positions per post.");
  const btns=$$("#jsv,#jdr");btns.forEach(b=>b.disabled=true);er("");
  const row={heading:h,country:country.slice(0,80),sector:sector.slice(0,80),positions:ps,urgent:$("#ju").checked,deadline:$("#jd").value||null,description:$("#jt").value.trim()||null,status};
  const {data,error}=job?await sb.from("jobs").update(row).eq("id",job.id).select().single():await sb.from("jobs").insert(row).select().single();
  if(error){btns.forEach(b=>b.disabled=false);return er(error.message)}
  const j=mapJob(data);
  if(job){Object.assign(job,j);close();toast("Saved");after&&after();return}
  jobs.unshift(j);
  if(status=="Draft"){close();toast("Draft saved. Publish it from the Job posts page.");after&&after();return}
  $("#modal").innerHTML=`<div class="card"><h2>Job post created</h2><p>${esc(j.heading)} with ${ps.length} positions is open. Share this link:</p><div class="linkbox"><input readonly value="${esc(linkFor(j.id))}"><button class="btn sm" id="cp">Copy</button></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" target="_blank" rel="noopener" href="${waLink(j)}">Share on WhatsApp</a><button class="btn sec" id="pv">Preview form</button><button class="btn sec" id="dn">Done</button></div></div>`;
  $("#cp").onclick=()=>copy(linkFor(j.id));$("#pv").onclick=()=>window.open(linkFor(j.id),"_blank");$("#dn").onclick=()=>{close();after&&after()}};
 $("#jsv").onclick=()=>save(job&&job.status!="Draft"?job.status:"Open");if($("#jdr"))$("#jdr").onclick=()=>save("Draft")}
const cbtn=()=>{$("#acts").innerHTML=`<button class="btn" id="nj">+ Create job post</button>`;$("#nj").onclick=()=>openCreate(()=>pages[page]())};
const pages={
dashboard(){const mx=Math.max(1,...jobs.map(j=>appCount(j.id)));
 shell("agency","dashboard.html","Dashboard",`${expiryAlerts()}<div class="grid g4">${stat("Total candidates",cands.length)}${stat("Active job posts",jobs.filter(j=>j.status=="Open").length)}${stat("New applications",cands.filter(c=>c.status=="New").length)}${stat("Shortlisted",cands.filter(c=>c.status=="Shortlisted").length)}</div>
 <div class="card" style="margin-top:14px"><h2>Job posts and applicants</h2><div class="tw"><table><thead><tr><th>Post</th><th>Positions</th><th>Status</th><th>Applicants</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr class="row" onclick="nav('candidates','job=${j.id}')"><td><b>${esc(j.heading)}</b>${j.urgent?' <span class="badge Urgent">Urgent</span>':""}</td><td>${j.positions.length}</td><td>${badge(j.status)}</td><td><b>${appCount(j.id)}</b></td><td style="min-width:120px"><div class="prog"><i style="width:${appCount(j.id)/mx*100}%"></i></div></td></tr>`).join("")||`<tr><td colspan=5 class="empty">No job posts yet. Create your first one.</td></tr>`}</tbody></table></div></div>`);cbtn()},
jobs(){const draw=()=>{$("#jl").innerHTML=jobs.map(j=>{const n=appCount(j.id);return`<div class="card post"><div class="ph"><div><h2>${esc(j.heading)}${j.urgent?' <span class="badge Urgent">Urgent</span>':""} ${badge(j.status)}</h2><small>${j.positions.length} positions · ${n} applicants · posted ${j.posted}${j.deadline?" · apply by "+esc(j.deadline):""} · <b style="color:${daysLeft(j)<=3?"var(--bad)":"inherit"}">auto-deletes ${inDays(daysLeft(j))}</b></small></div>
  <div class="pa">${j.status=="Draft"?"":`<button class="btn sec sm" onclick="copy(linkFor('${j.id}'))">Copy link</button><a class="btn sec sm" target="_blank" rel="noopener" href="${waLink(j)}">WhatsApp</a>`}<button class="btn sec sm" onclick="dlShortlisted('${j.id}')">Download shortlisted (${shortlisted(j.id).length})</button><button class="btn sec sm" onclick="editJob('${j.id}')">Edit</button><button class="btn sec sm" onclick="setJob('${j.id}')">${j.status=="Open"?"Close":j.status=="Draft"?"Publish":"Reopen"}</button><button class="btn red sm" onclick="delJob('${j.id}')">Delete</button></div></div>
  <div class="tw"><table><thead><tr><th>Position</th><th>Applicants</th><th></th></tr></thead><tbody>${j.positions.map(p=>{const c=cands.filter(x=>x.job==j.id&&x.position==p).length;return`<tr class="row" onclick="nav('candidates','job=${j.id}&pos='+encodeURIComponent(this.dataset.p))" data-p="${esc(p)}"><td>${esc(p)}</td><td><b>${c}</b></td><td style="width:40%"><div class="prog"><i style="width:${n?c/n*100:0}%"></i></div></td></tr>`}).join("")}</tbody></table></div></div>`}).join("")||`<div class="card empty">No job posts yet. Create your first one.</div>`};
 shell("agency","jobs.html","Job posts",`<div id="jl" class="grid"></div>`);cbtn();draw();
 window.editJob=id=>openCreate(draw,jobs.find(x=>x.id==id));
 window.setJob=async id=>{const j=jobs.find(x=>x.id==id),ns=j.status=="Open"?"Closed":"Open";const {error}=await sb.from("jobs").update({status:ns}).eq("id",id);if(error)return fail(error);j.status=ns;draw()};
 window.delJob=async id=>{if(!confirm("Delete this job post together with all its applications and resumes? This cannot be undone."))return;
  try{await deleteResumes(cands.filter(c=>c.job==id).map(c=>c.key));const {error}=await sb.from("jobs").delete().eq("id",id);if(error)throw error;jobs=jobs.filter(x=>x.id!=id);cands=cands.filter(c=>c.job!=id);draw();toast("Job deleted")}catch(e){fail(e)}}},
candidates(){let pg=1,urgent=false,cj=Q.get("job")||"";const PS=10,post=()=>jobs.find(j=>j.id==cj);
 const chips=()=>`<button class="chip ${cj?"":"on"}" data-j="">All posts (${cands.length})</button>`+jobs.map(j=>`<button class="chip ${j.id==cj?"on":""}" data-j="${j.id}">${esc(j.heading)} (${appCount(j.id)})</button>`).join("");
 const posOpts=()=>`<option value="">All positions</option>`+(post()?post().positions:[...new Set([...POSITIONS,...jobs.flatMap(j=>j.positions)])]).map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join("");
 const filt=()=>{const q=$("#q").value.toLowerCase(),p=$("#fp").value,s=$("#fs").value,c=$("#fc").value,m=+$("#fe").value||0;
  return cands.filter(x=>(!cj||x.job==cj)&&(!p||x.position==p)&&(!s||x.status==s)&&(!c||x.certs.includes(c))&&x.exp>=m&&(!q||(x.name+x.position+x.certs.join()).toLowerCase().includes(q))).sort($("#so").value=="exp"?(a,b)=>b.exp-a.exp:(a,b)=>b.date.localeCompare(a.date))};
 const draw=()=>{const f=filt(),pages=Math.max(1,Math.ceil(f.length/PS));pg=Math.min(pg,pages);
  $("#ct").innerHTML=f.slice((pg-1)*PS,pg*PS).map(c=>`<tr class="row" onclick="openC('${c.id}')"><td><b>${esc(c.name)}</b></td><td>${esc(c.position)}</td><td><b>${c.exp} yrs</b></td><td>${esc(c.certs[0]||"-")}</td><td>${c.date}</td><td>${badge(c.status)}</td></tr>`).join("")||`<tr><td colspan=6 class="empty">No candidates match your filters.</td></tr>`;
  $("#pi").textContent=`${f.length} candidates · page ${pg}/${pages}`;$("#pp").disabled=pg<=1;$("#pn").disabled=pg>=pages};
 shell("agency","candidates.html","Candidates",`<div class="bar" id="ch"></div><div class="bar"><input id="q" placeholder="Search name, position, certification" aria-label="Search"><select id="fp"></select><select id="fs"><option value="">All statuses</option>${sts.map(s=>`<option>${s}</option>`).join("")}</select><select id="fc"><option value="">All certifications</option>${certs.map(s=>`<option>${s}</option>`).join("")}</select></div>
 <div class="bar"><input id="fe" type="number" min="0" placeholder="Min. experience (yrs)" aria-label="Minimum experience"><select id="so"><option value="exp">Most experience first</option><option value="new">Newest first</option></select><button class="chip" id="ur">Urgent: 8+ yrs</button></div>
 <div class="card tw"><table><thead><tr><th>Name</th><th>Position</th><th>Experience</th><th>Certification</th><th>Applied</th><th>Status</th></tr></thead><tbody id="ct"></tbody></table></div><div class="pager"><span id="pi"></span><span><button class="btn sec sm" id="pp">Prev</button> <button class="btn sec sm" id="pn">Next</button></span></div>`);
 const paint=()=>{$("#ch").innerHTML=chips();$$("#ch .chip").forEach(b=>b.onclick=()=>{cj=b.dataset.j;$("#fp").innerHTML=posOpts();pg=1;paint();draw()})};
 $("#fp").innerHTML=posOpts();$("#fp").value=Q.get("pos")||"";paint();
 $$("#q,#fp,#fs,#fc,#fe,#so").forEach(e=>e.oninput=()=>{pg=1;draw()});$("#pp").onclick=()=>{pg--;draw()};$("#pn").onclick=()=>{pg++;draw()};
 $("#ur").onclick=e=>{urgent=!urgent;e.target.classList.toggle("on",urgent);$("#fe").value=urgent?8:"";$("#so").value="exp";pg=1;draw()};draw();
 window.openC=id=>{const c=cands.find(x=>x.id==id),d=$("#drawer");
  d.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center"><h2>${esc(c.name)}</h2><button class="btn sec sm" onclick="$('#drawer').classList.remove('open')">Close</button></div>
  <p>${esc(c.email)}<br>${esc(c.phone)}</p><p><b>Post:</b> ${esc(jobName(c.job))}<br><b>Position:</b> ${esc(c.position)}<br><b>Experience:</b> ${c.exp} yrs · <b>Now:</b> ${esc(c.loc)} · <b>Prefers:</b> ${esc(c.pref)}<br><b>Certifications:</b> ${esc(c.certs.join(", ")||"-")}<br><b>Applied on:</b> ${c.date}</p>
  ${c.hasResume?`<h2>Resume (${c.size} MB PDF)</h2><div style="display:flex;gap:8px;margin:8px 0"><button class="btn sm" id="rv">View resume</button><button class="btn sec sm" id="rdl">Download</button></div><small style="color:var(--mut)">Opens through a private link that expires in 5 minutes. Only your agency can open it.</small>`:`<h2>Resume</h2><p style="color:var(--mut)">No resume on file.</p>`}
  <label>Status</label><select id="ds">${sts.map(s=>`<option ${s==c.status?"selected":""}>${s}</option>`).join("")}</select>
  <h2 style="margin-top:16px">Recruiter notes</h2><div id="nl"><small style="color:var(--mut)">Loading notes...</small></div><textarea id="nt" rows=2 maxlength="2000" placeholder="Add a note"></textarea><button class="btn sm" style="margin-top:6px" id="an">Add note</button>
  <div style="margin-top:22px;padding-top:12px;border-top:1px dashed var(--line)"><button class="btn red sm" id="dc">Delete candidate and resume</button></div>`;
  d.classList.add("open");
  const note=n=>`<div class="note">${esc(n.text)}<br><small>${when(n.created_at)}</small></div>`;
  sb.from("notes").select("text,created_at").eq("candidate_id",id).order("created_at").then(({data,error})=>{if(!$("#nl"))return;$("#nl").innerHTML=error?`<small style="color:var(--bad)">Could not load notes.</small>`:data.map(note).join("")});
  const link=dl=>resumeUrl(c.key,dl);
  if($("#rv"))$("#rv").onclick=async()=>{const w=window.open("","_blank");try{const u=await link(false);if(w)w.location.href=u;else location.href=u}catch(e){w&&w.close();fail(e)}};
  if($("#rdl"))$("#rdl").onclick=async()=>{try{location.href=await link(true)}catch(e){fail(e)}};
  $("#ds").onchange=async e=>{const prev=c.status,v=e.target.value;const {error}=await sb.from("candidates").update({status:v}).eq("id",id);if(error){e.target.value=prev;return fail(error)}c.status=v;draw();toast("Status updated")};
  $("#an").onclick=async()=>{const t=$("#nt").value.trim();if(!t)return;const b=$("#an");b.disabled=true;const {data,error}=await sb.from("notes").insert({candidate_id:id,text:t}).select("text,created_at").single();b.disabled=false;if(error)return fail(error);$("#nl").insertAdjacentHTML("beforeend",note(data));$("#nt").value=""};
  $("#dc").onclick=async()=>{if(!confirm("Delete this candidate and their resume permanently?"))return;try{await deleteResumes([c.key]);const {error}=await sb.from("candidates").delete().eq("id",id);if(error)throw error;cands=cands.filter(x=>x.id!=id);d.classList.remove("open");paint();draw();toast("Candidate deleted")}catch(e){fail(e)}}}},
admin(){const showCode=a=>{const url=location.href.replace(/[^\/]*$/,"")+"index.html";$("#modal").innerHTML=`<div class="card"><h2>Access code for ${esc(a.name)}</h2><div class="linkbox"><input readonly value="${esc(a.code)}" style="font:700 18px monospace"><button class="btn sm" id="cc">Copy</button></div><p style="color:var(--mut)">Plan: ${esc(a.plan)}, valid until ${esc(a.expires)}. Send this code to the agency owner; it works only with their email and password.</p><div style="display:flex;gap:8px"><a class="btn" href="mailto:${encodeURIComponent(a.email)}?subject=${encodeURIComponent("Your HirePool access code")}&body=${encodeURIComponent(`Hello,\n\nYour HirePool account is approved.\nAccess code: ${a.code}\nLogin: ${url}\n\nUse your signup email and password with this code.`)}">Email to agency</a><button class="btn sec" id="dn">Done</button></div></div>`;$("#modal").classList.add("open");$("#cc").onclick=()=>copy(a.code);$("#dn").onclick=close};
 const draw=()=>{const pend=accounts.filter(a=>a.status=="Pending"),rest=accounts.filter(a=>a.status!="Pending"),av=a=>a.logo?`<img src="${esc(a.logo)}" alt="" class="av">`:`<span class="av">${esc(a.name[0])}</span>`;
  $("#st").innerHTML=stat("Agencies",rest.length)+stat("Active",rest.filter(a=>a.status=="Active").length)+stat("Signup requests",pend.length)+stat("Suspended",rest.filter(a=>a.status=="Suspended").length);
  const S=adminStats;$("#st2").innerHTML=stat("Total jobs",S.jobs??0)+stat("Total applications",S.applications??0)+stat("Resume storage used",fmtB(S.storage_bytes))+stat("Applications (7 days)",S.new_apps_7d??0);
  $("#act").textContent=`${S.new_agencies_7d??0} new agency signups · ${S.new_jobs_7d??0} new job posts · ${S.new_apps_7d??0} new applications`;
  $("#rq").innerHTML=pend.map(a=>`<tr><td>${av(a)} <b>${esc(a.name)}</b></td><td>${esc(a.email)}</td><td>${esc(a.phone||"-")}</td><td>${esc(a.plan)}</td><td>${esc(a.requested)}</td><td><button class="btn sm" onclick="approve('${a.id}')">Approve</button> <button class="btn red sm" onclick="rej('${a.id}')">Reject</button></td></tr>`).join("")||`<tr><td colspan=6 class="empty">No pending signup requests.</td></tr>`;
  $("#ag").innerHTML=rest.map(a=>`<tr><td>${av(a)} <b>${esc(a.name)}</b></td><td>${esc(a.email)}</td><td>${esc(a.phone||"-")}</td><td>${esc(a.plan||"-")}</td><td>${esc(a.expires||"-")}</td><td>${badge(a.status)}</td><td>${usage[a.id]?.jobs??0}</td><td>${usage[a.id]?.applications??0}</td><td>${fmtB(usage[a.id]?.storage_bytes)}</td><td><code>${esc(a.code||"-")}</code></td><td>${a.status=="Rejected"?"":`<button class="btn sec sm" onclick="tog('${a.id}')">${a.status=="Active"?"Suspend":"Reactivate"}</button> <button class="btn sec sm" onclick="regen('${a.id}')">New code</button>`}</td></tr>`).join("")||`<tr><td colspan=11 class="empty">No agencies yet.</td></tr>`};
 shell("admin","admin.html","Platform overview",`<div class="grid g4" id="st"></div><div class="grid g4" id="st2" style="margin-top:14px"></div><div class="card" style="margin-top:14px"><h2>Platform activity (last 7 days)</h2><p id="act" style="margin:0;color:var(--mut)"></p></div><div class="card" style="margin-top:14px"><h2>Signup requests</h2><div class="tw"><table><thead><tr><th>Agency</th><th>Email</th><th>Mobile</th><th>Plan requested</th><th>Requested</th><th></th></tr></thead><tbody id="rq"></tbody></table></div></div>
 <div class="card" style="margin-top:14px"><h2>Agencies</h2><div class="tw"><table><thead><tr><th>Agency</th><th>Email</th><th>Mobile</th><th>Plan</th><th>Valid until</th><th>Status</th><th>Jobs</th><th>Applicants</th><th>Storage</th><th>Access code</th><th></th></tr></thead><tbody id="ag"></tbody></table></div></div>`);draw();
 const upd=(a,row)=>{Object.assign(a,mapAcc(row));draw()};
 window.approve=id=>{const a=accounts.find(x=>x.id==id);$("#modal").innerHTML=`<div class="card"><h2>Approve ${esc(a.name)}</h2><p style="color:var(--mut)">Confirm payment, choose the plan, then generate a unique access code.</p><label>Plan</label><select id="pm"><option value="1">1 month (₹4,999)</option><option value="3">3 months (₹11,999)</option><option value="6">6 months (custom price)</option></select><div class="err" id="ae"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn sec" id="cx">Cancel</button><button class="btn" id="ok">Approve and generate code</button></div></div>`;
  $("#modal").classList.add("open");$("#pm").value=parseInt(a.plan)||1;$("#cx").onclick=close;
  $("#ok").onclick=async()=>{const b=$("#ok");b.disabled=true;const {data,error}=await sb.rpc("admin_approve",{p_id:id,p_months:+$("#pm").value});b.disabled=false;if(error)return $("#ae").textContent=error.message;upd(a,data);showCode(a)}};
 window.rej=async id=>{if(!confirm("Reject this signup request?"))return;const {data,error}=await sb.rpc("admin_reject",{p_id:id});if(error)return fail(error);upd(accounts.find(x=>x.id==id),data)};
 window.tog=async id=>{const a=accounts.find(x=>x.id==id);const {data,error}=await sb.rpc("admin_set_status",{p_id:id,p_status:a.status=="Active"?"Suspended":"Active"});if(error)return fail(error);upd(a,data)};
 window.regen=async id=>{if(!confirm("Create a new access code? The old code will stop working."))return;const a=accounts.find(x=>x.id==id);const {data,error}=await sb.rpc("admin_regen_code",{p_id:id});if(error)return fail(error);upd(a,data);showCode(a)}},
async apply(){let j=null;
 try{const {data}=await sb.rpc("public_job",{p_id:Q.get("job")||""});j=data||null}catch(e){}
 if(!j){$("#box").innerHTML=`<h2>This job link is closed or invalid</h2><p>Please contact the agency for a new link.</p>`;return}
 $("#hd").textContent=j.heading;document.title="Apply | "+j.heading;$("#pos").innerHTML=j.positions.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join("");const MAX=20;
 if(j.agency)$("#ag").textContent="Hiring agency: "+j.agency;
 $("#f").onsubmit=async e=>{e.preventDefault();const er=[],v=id=>$("#"+id).value.trim(),f=$("#cv").files[0],btn=$("#f button");
  if(v("n").length<2)er.push("Enter your full name.");if(!/^\+?[\d\s-]{8,15}$/.test(v("ph")))er.push("Enter a valid phone number.");if(!/^\S+@\S+\.\S+$/.test(v("em")))er.push("Enter a valid email.");
  if(v("ex")===""||+v("ex")<0||+v("ex")>50)er.push("Enter experience between 0 and 50 years.");
  if(!f)er.push("Upload your resume (PDF).");
  else if(f.type!="application/pdf"&&!f.name.toLowerCase().endsWith(".pdf"))er.push("Resume must be a PDF.");
  else if(f.size>MAX*1048576)er.push(`Resume must be under ${MAX} MB.`);
  else if(f.size<100)er.push("Resume file looks empty.");
  else if(await f.slice(0,5).text()!=="%PDF-")er.push("This file is not a valid PDF.");
  if(!$("#ok").checked)er.push("Please accept the privacy notice.");
  $("#er").innerHTML=er.map(esc).join("<br>");if(er.length)return;
  btn.disabled=true;btn.textContent="Submitting...";
  try{
   // 1) the database validates the details and returns the one path this browser may upload to
   const r=await sb.rpc("submit_application",{p_job:j.id,p_name:v("n"),p_email:v("em"),p_phone:v("ph"),p_position:$("#pos").value,p_exp:+v("ex"),p_loc:v("cl"),p_pref:v("pl"),p_certs:v("sk").split(/[,;]/).map(x=>x.trim()).filter(Boolean),p_consent:true});
   if(r.error)throw new Error(r.error.code=="P0001"?r.error.message:"Could not submit. Please try again.");
   // 2) upload the PDF straight into the private bucket (no overwrite allowed)
   const up=await sb.storage.from("resumes").upload(r.data.path,f,{contentType:"application/pdf",upsert:false});
   if(up.error)throw new Error(/size|exceed|too large/i.test(up.error.message)?`Resume must be under ${MAX} MB.`:"Resume upload failed. Please try again.");
   // 3) the database confirms the file really arrived
   const fin=await sb.rpc("finalize_application",{p_candidate:r.data.candidate_id});
   if(fin.error||!fin.data)throw new Error("We could not confirm your upload. Please submit again.");
   $("#f").style.display="none";$("#done").style.display="block"}
  catch(x){console.error(x);$("#er").textContent=x.message||"Could not submit. Please try again."}
  finally{btn.disabled=false;btn.textContent="Submit application"}}}};
// ---- Navigation inside the agency area without reloading the page ----
async function nav(p,qs=""){
 if(!["dashboard","jobs","candidates"].includes(p))return;
 try{if(Date.now()-stamp>60000){await loadAgencyData();stamp=Date.now()}}catch(e){console.error(e)}  // refresh data only if older than 1 minute
 page=p;Q=new URLSearchParams(qs);history.pushState({},"",p+".html"+(qs?"?"+qs:""));document.title="HirePool - "+p[0].toUpperCase()+p.slice(1);pages[p]()}
document.addEventListener("click",e=>{const a=e.target.closest&&e.target.closest("a[data-nav]");if(!a||e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey)return;e.preventDefault();nav(a.dataset.nav)});
window.addEventListener("popstate",()=>{const p=(location.pathname.split("/").pop()||"").replace(/\.html$/,"");if(profile&&["dashboard","jobs","candidates"].includes(p)){page=p;Q=new URLSearchParams(location.search);pages[p]()}});
(async()=>{try{
 if(page=="apply")return await pages.apply();
 document.body.insertAdjacentHTML("afterbegin",`<div style="padding:40px;font:15px 'DM Sans',sans-serif;color:#5b6078">Loading...</div>`);
 const role=page=="admin"?"admin":"agency";
 // Agency: load data while the access check runs (faster). Admin: check access first, then load.
 const data=role=="admin"?null:loadAgencyData().catch(e=>e||new Error("load failed"));
 const why=await boot(role);if(why){console.warn("HirePool access:",why);return go(why)}
 sweep();
 const err=role=="admin"?await loadAdminData().then(()=>0,e=>e||new Error("load failed")):await data;if(err)throw err;
 stamp=Date.now();pages[page]?.()
}catch(e){console.error(e);document.body.innerHTML=`<div class="center"><div class="card"><h2>Something went wrong</h2><p style="color:var(--mut)">${esc(e?.message||"Could not load your data.")} Check your connection and try again.</p><button class="btn" onclick="location.reload()">Reload</button> <button class="btn sec" onclick="logout()">Logout</button></div></div>`}})();
