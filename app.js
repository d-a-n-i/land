'use strict';
// When do I land? - GPS + great-circle + approach model, with online route/ADS-B enrichment.
const $ = id => document.getElementById(id);
const KT = 1.852; // km/h per knot
const LS = { last: 'land.last', routes: 'land.routes', dest: 'land.dest' };
const HOME = 'TLV';

// Typical extra minutes for arrival routing/vectoring beyond straight-in (rough, from common STAR/holding patterns).
const PAD = { EWR:7, JFK:7, LGA:6, LHR:8, LGW:5, FRA:6, MUC:5, IAH:5, DFW:5, ATL:6, ORD:6, LAX:5, SFO:6, CDG:6, AMS:5, IST:5, DXB:5, BOS:5, IAD:4, MIA:4, ZRH:4, VIE:4, FCO:4, MAD:4, BCN:4, ATH:3, TLV:3, AUS:3, HOU:3 };
const TAXI = { EWR:10, JFK:12, LHR:10, FRA:9, IAH:8, DFW:10, ATL:11, ORD:11, CDG:10, AMS:10, IST:9, TLV:7 };
const DEFAULT_PAD = 4, DEFAULT_TAXI = 7;
// Major long-haul hubs used for the cruise-phase guess (descent switches to any large airport ahead).
const HUBS = new Set('TLV ATH IST SAW LHR LGW MAN DUB CDG ORY AMS FRA MUC ZRH VIE BRU CPH ARN OSL HEL WAW PRG BUD OTP SOF LCA FCO MXP MAD BCN LIS DXB AUH DOH CAI AMM RUH JED BOM DEL BKK SIN HKG ICN NRT HND PEK PVG JFK EWR BOS IAD PHL ATL MIA ORD DFW IAH DEN LAX SFO SEA YYZ YUL MEX GRU EZE JNB ADD NBO SYD MEL'.split(' '));

let fixCount = 0, gpsErr = null;
let airports = null, dest = null, route = null, flight = null;
let mode = 'auto', autoTag = '', track = null, trackFixes = [], altHist = [];
let wasAirborne = false;
let gps = null, lastFix = null, gsEma = null, cruiseGs = null, live = null, liveAt = 0, landedAt = null;

function norm(s){ return (s||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function toRad(d){ return d*Math.PI/180; }
function hav(a,b,c,d){ const R=6371, x=toRad(c-a), y=toRad(d-b);
  const h=Math.sin(x/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(y/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function fmtTime(ms, tz){ try{ return new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:tz}).format(new Date(ms)); }catch(e){ return new Date(ms).toTimeString().slice(0,5); } }
function fmtDur(min){ min=Math.max(0,Math.round(min)); const h=Math.floor(min/60), m=min%60; return h? `${h}h ${String(m).padStart(2,'0')}m` : `${m} min`; }
function tzAbbr(tz){ try{ return new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'short'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName').value; }catch(e){ return ''; } }
function sameTz(tz){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone===tz; }catch(e){ return false; } }
function routes(){ try{ return JSON.parse(localStorage.getItem(LS.routes)||'{}'); }catch(e){ return {}; } }
function saveRoute(f,r){ const all=routes(); all[f]=r; localStorage.setItem(LS.routes, JSON.stringify(all)); }

async function loadAirports(){ if(airports) return airports; const r=await fetch('airports.json'); airports=await r.json(); return airports; }
function ap(code){ const a=airports&&airports[code]; return a? {code, lat:a[0], lon:a[1], tz:a[2], name:a[3], city:a[4]} : null; }

// Minutes from `d` km out to touchdown. gsKmh = current ground speed (wind included).
function minutesToGo(d, gsKmh, code){
  const pad = PAD[code] ?? DEFAULT_PAD;
  const ref = Math.max(cruiseGs || gsKmh || 830, 500);
  const DESC = 200, FINAL = 60;
  const vDesc = Math.max(430, 0.72*ref);   // average over descent: cruise speed bleeding to ~250 kt
  const vFinal = 300;                       // ~160 kt average in terminal area / final
  let t = 0, rem = d;
  if (rem > DESC){ t += (rem-DESC)/Math.max(gsKmh||ref, 300); rem = DESC; }
  if (rem > FINAL){ // inside descent: trust the real speed more as it drops
    const v = (d<=DESC && gsKmh>250) ? (gsKmh+vDesc)/2 : vDesc;
    t += (rem-FINAL)/v; rem = FINAL;
  }
  const vF = (d<=FINAL && gsKmh>200) ? Math.min(gsKmh, 420)*0.6 + vFinal*0.4 : vFinal;
  t += rem/vF;
  t += (pad/60) * Math.min(1, d/FINAL); // vectoring padding fades out on final
  return t*60;
}

function render(){
  updateGpsInd(); autoPick();
  if(!dest){ return; }
  const now = Date.now();
  let pos = null, srcTxt = '';
  const gpsFresh = lastFix && now - lastFix.t < 60000;
  const liveFresh = live && now - liveAt < 120000;
  if (gpsFresh){ pos = {lat:lastFix.lat, lon:lastFix.lon, gs:gsEma, alt:lastFix.alt}; srcTxt = `Your GPS (±${Math.round(lastFix.acc)} m)`; }
  else if (liveFresh){ pos = {lat:live.lat, lon:live.lon, gs:live.gs, alt:live.alt}; srcTxt = `Live ADS-B via adsb.lol, ${Math.round((now-liveAt)/1000)}s old`; }

  const taxi = TAXI[dest.code] ?? DEFAULT_TAXI;
  const tzNote = sameTz(dest.tz) ? '' : ` ${tzAbbr(dest.tz)}`;
  if (!pos){
    $('heroLabel').textContent = 'Waiting for position';
    $('eta').textContent = '--:--';
    $('etaSub').textContent = gps ? 'Getting a GPS fix... phone near a window helps' : 'Allow location to start';
    if (route && route.origin){ const o=ap(route.origin); if(o){ const d=hav(o.lat,o.lon,dest.lat,dest.lon);
      const block = d/830*60 + 22; $('band').textContent = `Typical airborne time ${fmtDur(block)} for ${Math.round(d)} km`; } }
    $('src').textContent = srcTxt;
    return;
  }
  const d = hav(pos.lat,pos.lon,dest.lat,dest.lon);
  const gsK = pos.gs!=null ? pos.gs*3.6 : null; // m/s -> km/h
  $('dist').textContent = d>=10 ? `${Math.round(d).toLocaleString()} km` : `${d.toFixed(1)} km`;
  $('gs').textContent = gsK!=null ? `${Math.round(gsK/KT)} kt` : '-';
  $('alt').textContent = pos.alt!=null ? `${Math.round(pos.alt*3.281).toLocaleString()} ft` : '-';
  $('src').textContent = srcTxt;

  const airborne = gsK!=null && gsK > 250;
  if (airborne && d > 250 && gsK > 500) cruiseGs = cruiseGs ? cruiseGs*0.98 + gsK*0.02 : gsK;
  if (airborne) { wasAirborne = true; landedAt = null; }
  if (wasAirborne && !airborne && d < 8 && gsK!=null && gsK < 110){ if(!landedAt) landedAt = now; }

  if (landedAt){
    $('heroLabel').textContent = 'Landed';
    $('eta').textContent = fmtTime(landedAt, dest.tz);
    $('etaSub').textContent = `At the gate around ${fmtTime(landedAt + taxi*60000, dest.tz)}${tzNote}`;
    $('gate').textContent = fmtTime(landedAt + taxi*60000, dest.tz); $('band').textContent = '';
    return;
  }
  if (!airborne && d < 30){
    $('heroLabel').textContent = `At ${dest.code}`; $('eta').textContent = '--:--';
    $('etaSub').textContent = 'Waiting for takeoff - destination is picked from your track once airborne';
    $('band').textContent = ''; $('gate').textContent = '-'; return;
  }
  if (!airborne){
    const mins = minutesToGo(d, 830, dest.code) + 12; // climb-out allowance
    $('heroLabel').textContent = 'On the ground';
    $('eta').textContent = fmtDur(mins);
    $('etaSub').textContent = 'expected flight time after takeoff';
    $('band').textContent = 'The clock time appears once you are airborne';
    $('gate').textContent = '-';
    return;
  }
  const mins = minutesToGo(d, gsK, dest.code);
  const eta = now + mins*60000;
  const spread = Math.round(3 + mins*0.03);
  $('heroLabel').textContent = `Landing at ${dest.code}`;
  $('eta').textContent = fmtTime(eta, dest.tz);
  $('etaSub').textContent = `in ${fmtDur(mins)}${tzNote ? ' · local'+tzNote : ''}${sameTz(dest.tz)?'':' · '+fmtTime(eta)+' your phone'}`;
  $('band').textContent = `±${spread} min · touchdown estimate`;
  $('gate').textContent = fmtTime(eta + taxi*60000, dest.tz);
}

function onFix(p){
  const c = p.coords, t = p.timestamp || Date.now();
  let spd = (c.speed!=null && !isNaN(c.speed)) ? c.speed : null;
  if (spd==null && lastFix && t>lastFix.t){ const dt=(t-lastFix.t)/1000; if(dt>=2) spd = hav(lastFix.lat,lastFix.lon,c.latitude,c.longitude)*1000/dt; }
  if (spd!=null){ gsEma = gsEma==null ? spd : gsEma*0.8 + spd*0.2; }
  lastFix = {lat:c.latitude, lon:c.longitude, acc:c.accuracy||0, alt:(c.altitude!=null?c.altitude:null), t, hdg:(c.heading!=null&&!isNaN(c.heading)&&spd>30)?c.heading:null};
  fixCount++;
  trackFixes.push(lastFix); trackFixes = trackFixes.filter(f => t - f.t < 180000);
  const old = trackFixes.find(f => t - f.t >= 45000) || trackFixes[0];
  if (old && old!==lastFix && hav(old.lat,old.lon,lastFix.lat,lastFix.lon) > 3) track = bearing(old.lat,old.lon,lastFix.lat,lastFix.lon);
  else if (lastFix.hdg!=null) track = lastFix.hdg;
  if (lastFix.alt!=null){ altHist.push([t,lastFix.alt]); altHist = altHist.filter(a => t - a[0] < 300000); }
  render();
}
function startGps(){
  if (gps || !('geolocation' in navigator)){ if(!('geolocation' in navigator)) $('msg').textContent='No GPS on this device/browser'; return; }
  gps = navigator.geolocation.watchPosition(onFix, e => { gpsErr = e.code===1 ? 'Location blocked - allow it in settings' : null; updateGpsInd(); },
    {enableHighAccuracy:true, maximumAge:5000, timeout:30000});
}

async function fetchJson(url, ms=8000){ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms);
  try{ const r=await fetch(url,{signal:c.signal, cache:'no-store'}); if(!r.ok) throw new Error(r.status); return await r.json(); } finally{ clearTimeout(t); } }

async function lookupRoute(f){
  const j = await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(f)}`);
  const fr = j && j.response && j.response.flightroute; if(!fr) throw new Error('unknown flight');
  return { origin: fr.origin.iata_code, dest: fr.destination.iata_code, icao: fr.callsign_icao || fr.callsign, airline: fr.airline && fr.airline.name, destName: fr.destination.name,
           destLat: fr.destination.latitude, destLon: fr.destination.longitude, at: Date.now() };
}
async function pollLive(){
  if (!route || !route.icao || !navigator.onLine) return;
  try{
    const j = await fetchJson(`https://api.adsb.lol/v2/callsign/${route.icao}`, 6000);
    const a = j.ac && j.ac.find(x => x.lat!=null);
    if (a){ live = {lat:a.lat, lon:a.lon, gs: a.gs!=null ? a.gs*KT/3.6 : null, alt: typeof a.alt_baro==='number' ? a.alt_baro/3.281 : null}; liveAt = Date.now(); render(); }
  }catch(e){ /* blocked, offline or not airborne: GPS/model carries on */ }
}


function bearing(a,b,c,d){ const y=Math.sin(toRad(d-b))*Math.cos(toRad(c)), x=Math.cos(toRad(a))*Math.sin(toRad(c))-Math.sin(toRad(a))*Math.cos(toRad(c))*Math.cos(toRad(d-b)); return (Math.atan2(y,x)*180/Math.PI+360)%360; }
function angDiff(a,b){ const d=Math.abs(a-b)%360; return d>180?360-d:d; }
function descending(){ if(altHist.length<3) return false; const a=altHist[0], b=altHist[altHist.length-1]; const dt=(b[0]-a[0])/60000; return dt>=1 && (a[1]-b[1])/dt > 150; } // > ~500 ft/min down

function updateGpsInd(){
  const el=$('gpsInd'), now=Date.now();
  const fresh = lastFix && now-lastFix.t < 20000;
  el.className = 'gps' + (gpsErr ? ' bad' : fresh ? ' ok' : '');
  $('gpsTxt').textContent = gpsErr ? gpsErr : fresh ? `GPS locked · ±${Math.round(lastFix.acc)} m` : lastFix ? `GPS lost ${Math.round((now-lastFix.t)/1000)}s ago - reacquiring...` : 'Acquiring location...';
}

// Auto destination: home (TLV) unless the track clearly points elsewhere.
function autoPick(){
  if (mode!=='auto' || !airports) return;
  const home = ap(HOME);
  const setDest = (a, tag) => { if(!dest || dest.code!==a.code){ dest=a; cruiseGs=null; landedAt=null; } autoTag=tag; showDest(); };
  if (!lastFix || track==null || !(gsEma>70)){ if(!dest || dest.code!==HOME) setDest(home, 'auto'); return; }
  const dHome = hav(lastFix.lat,lastFix.lon,home.lat,home.lon);
  const offHome = angDiff(track, bearing(lastFix.lat,lastFix.lon,home.lat,home.lon));
  // Heading roughly home (routes wiggle and turn onto the approach), or already on final into TLV
  const desc = descending();
  const homeish = dHome < 40 || offHome < 20 || (dHome < 500 && offHome < 60) || (!desc && offHome < 35);
  if (homeish && !(desc && dHome > 400 && offHome > 15)){ setDest(home, 'auto'); return; }
  let best=null, bestScore=1e9;
  for (const [code,a] of Object.entries(airports)){
    const big=a[5]===1; if(desc ? false : !HUBS.has(code)) continue;
    const d=hav(lastFix.lat,lastFix.lon,a[0],a[1]); if(d<15 || d>9000) continue;
    const off=angDiff(track, bearing(lastFix.lat,lastFix.lon,a[0],a[1]));
    const cone = desc ? 60 : 15; if(off>cone) continue; if(!desc && d<300) continue;
    const xt = d*Math.sin(toRad(off)); // km off the current track
    // descending: nearest well-aligned airport; cruising: well-aligned and far (you're not landing at a hub you're overflying at FL360)
    const score = desc ? d*0.5 + xt*3 + (big?0:60) : xt;
    if(score<bestScore){ bestScore=score; best=code; }
  }
  if (best) setDest(ap(best), desc ? 'auto · descending' : 'auto · guess');
  else if(!dest) setDest(home, 'auto');
}
function showDest(){
  if(!dest) return;
  $('destCode').textContent = dest.code;
  $('destTag').textContent = mode==='auto' ? autoTag : mode==='flight' ? flight : 'set';
  if (mode!=='flight') $('route').textContent = `${dest.city||dest.name}${mode==='auto' && dest.code!==HOME ? ' - tap to change' : ''}`;
}

async function setTarget(input){
  const q = norm(input);
  $('msg').textContent=''; landedAt=null; cruiseGs=null; live=null; route=null; flight=null;
  await loadAirports();
  if (!q){ mode='auto'; localStorage.removeItem(LS.dest); dest=null; autoPick(); render(); return; }
  if (/^[A-Z]{3}$/.test(q) && ap(q)){ mode='manual'; dest=ap(q); localStorage.setItem(LS.dest,q); showDest(); render(); return; }
  // secondary path: flight number
  flight=q; const cached=routes()[q];
  if (navigator.onLine){ try{ route=await lookupRoute(q); saveRoute(q,route); }catch(e){ route=cached||null; } } else route=cached||null;
  if (!route){ $('msg').textContent=`Couldn't resolve ${q}${navigator.onLine?'':' offline'} - type the airport code instead`; flight=null; return; }
  mode='flight'; localStorage.setItem(LS.dest,q); localStorage.setItem(LS.last,q);
  dest = ap(route.dest) || {code:route.dest, lat:route.destLat, lon:route.destLon, tz:Intl.DateTimeFormat().resolvedOptions().timeZone, name:route.destName};
  showDest();
  $('route').textContent = `${route.airline ? route.airline+' · ' : ''}${q} ${route.origin} → ${route.dest}`;
  render(); pollLive();
}

$('destBtn').addEventListener('click', () => { const f=$('f'); f.hidden=!f.hidden; if(!f.hidden){ $('q').value=''; $('q').focus(); } });
$('f').addEventListener('submit', e => { e.preventDefault(); $('f').hidden=true; setTarget($('q').value); });
setInterval(render, 3000);
setInterval(pollLive, 30000);
window.addEventListener('online', pollLive);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
(async () => { await loadAirports(); const saved=localStorage.getItem(LS.dest); startGps(); await setTarget(saved||''); })();
