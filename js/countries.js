// Mobile number rules for the signup form. The user picks a country, types the national number,
// and we store it in international format (+<country code><number>).
// The patterns cover normal mobile numbers of these countries. Any other country: choose "Other" and type +code number.
const PHONE_COUNTRIES=[
 {c:"IN",n:"India",d:"91",re:/^[6-9]\d{9}$/,h:"10 digits, starts with 6, 7, 8 or 9"},
 {c:"KW",n:"Kuwait",d:"965",re:/^[569]\d{7}$/,h:"8 digits, starts with 5, 6 or 9"},
 {c:"QA",n:"Qatar",d:"974",re:/^[3567]\d{7}$/,h:"8 digits, starts with 3, 5, 6 or 7"},
 {c:"AE",n:"United Arab Emirates",d:"971",re:/^5\d{8}$/,h:"9 digits, starts with 5"},
 {c:"SA",n:"Saudi Arabia",d:"966",re:/^5\d{8}$/,h:"9 digits, starts with 5"},
 {c:"OM",n:"Oman",d:"968",re:/^[79]\d{7}$/,h:"8 digits, starts with 7 or 9"},
 {c:"BH",n:"Bahrain",d:"973",re:/^[36]\d{7}$/,h:"8 digits, starts with 3 or 6"},
 {c:"PK",n:"Pakistan",d:"92",re:/^3\d{9}$/,h:"10 digits, starts with 3"},
 {c:"BD",n:"Bangladesh",d:"880",re:/^1[3-9]\d{8}$/,h:"10 digits, starts with 13 to 19"},
 {c:"NP",n:"Nepal",d:"977",re:/^9[78]\d{8}$/,h:"10 digits, starts with 97 or 98"},
 {c:"LK",n:"Sri Lanka",d:"94",re:/^7\d{8}$/,h:"9 digits, starts with 7"},
 {c:"PH",n:"Philippines",d:"63",re:/^9\d{9}$/,h:"10 digits, starts with 9"},
 {c:"EG",n:"Egypt",d:"20",re:/^1[0125]\d{8}$/,h:"10 digits, starts with 10, 11, 12 or 15"},
 {c:"JO",n:"Jordan",d:"962",re:/^7[789]\d{7}$/,h:"9 digits, starts with 77, 78 or 79"},
 {c:"IQ",n:"Iraq",d:"964",re:/^7\d{9}$/,h:"10 digits, starts with 7"},
 {c:"ID",n:"Indonesia",d:"62",re:/^8\d{8,11}$/,h:"9 to 12 digits, starts with 8"},
 {c:"MY",n:"Malaysia",d:"60",re:/^1\d{8,9}$/,h:"9 or 10 digits, starts with 1"},
 {c:"SG",n:"Singapore",d:"65",re:/^[89]\d{7}$/,h:"8 digits, starts with 8 or 9"},
 {c:"GB",n:"United Kingdom",d:"44",re:/^7\d{9}$/,h:"10 digits, starts with 7"},
 {c:"US",n:"United States / Canada",d:"1",re:/^[2-9]\d{9}$/,h:"10 digits"},
 {c:"AU",n:"Australia",d:"61",re:/^4\d{8}$/,h:"9 digits, starts with 4"},
 {c:"NG",n:"Nigeria",d:"234",re:/^[789]\d{9}$/,h:"10 digits, starts with 7, 8 or 9"},
 {c:"KE",n:"Kenya",d:"254",re:/^[17]\d{8}$/,h:"9 digits, starts with 1 or 7"}];
const phoneHint=code=>{const c=PHONE_COUNTRIES.find(x=>x.c===code);return code==="OTHER"?"Type the full number with +country code, e.g. +255712345678":c?`+${c.d} then ${c.h}`:""};
function validatePhone(code,raw){
 const s=String(raw||"").trim();
 if(code==="OTHER"){const t=s.replace(/[ \-().]/g,"");return /^\+[1-9]\d{7,14}$/.test(t)?{ok:true,e164:t}:{ok:false,msg:"Enter the full international number, starting with + and the country code (8 to 15 digits)."}}
 const c=PHONE_COUNTRIES.find(x=>x.c===code);if(!c)return{ok:false,msg:"Choose your country."};
 if(s.startsWith("+"))return{ok:false,msg:"Do not type the country code. It is already selected."};
 let t=s.replace(/[ \-().]/g,"");
 if(!t)return{ok:false,msg:"Enter your mobile number."};
 if(!/^\d+$/.test(t))return{ok:false,msg:"Use digits only in the mobile number."};
 t=t.replace(/^0+/,"");
 if(!c.re.test(t))return{ok:false,msg:`Enter a valid ${c.n} mobile number: ${c.h}.`};
 return{ok:true,e164:"+"+c.d+t}}
if(typeof module!=="undefined")module.exports={PHONE_COUNTRIES,validatePhone,phoneHint};
