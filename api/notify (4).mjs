/* Endpoint Vercel: kirim notifikasi push real-time saat ada perubahan di project.
   Dipanggil oleh app (index.html) setelah seseorang menyimpan perubahan.
   Env yang dibutuhkan di Vercel: FIREBASE_SERVICE_ACCOUNT (JSON service account yang sama dengan di GitHub),
   opsional APP_URL (mis. https://namaapp.vercel.app). Dependensi: firebase-admin. */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const COLLECTION = 'wedding_kv';
const APP_VERSION = 'v4';
const PROJECT_KEY = id => 'wedding_project_' + APP_VERSION + '_' + id;
const SCHEDULE_KEY = 'wedding_vendor_schedule_' + APP_VERSION;
const TOKEN_PREFIX = 'push_token_';
const ROLE_HASH = { admin:'#admin', marketing:'#marketing', client:'#clientlink', vendor:'#vendorlink' };
const ACTOR_LABEL = { client:'Klien', admin:'Admin', marketing:'Marketing', vendor:'Vendor' };
const DOC_WHITELIST = ['MOU', 'Rundown', 'Invoice'];
const MAX_EVENTS = 12;

const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n || 60);

const CHANGE_LABEL = { title:'judul', date:'tanggal', time:'jam', location:'lokasi', desc:'deskripsi', status:'status', cc:'konfirmasi klien' };
const CHANGE_CODES = [...Object.keys(CHANGE_LABEL), 'new', 'deleted'];
/* Selisih hari terhadap hari ini (zona WIB, UTC+7) */
function daysLeft(iso){
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}
function relDays(n){
  if(n === 0) return 'hari ini';
  if(n === 1) return 'besok';
  if(n > 1) return `${n} hari lagi`;
  return `sudah lewat ${-n} hari`;
}
function timelineText(ev){
  if(!ev.title) return 'memperbarui timeline / agenda';
  const ch = Array.isArray(ev.changes) ? ev.changes : [];
  if(ch.includes('deleted')) return `menghapus agenda "${ev.title}"`;
  let s = (ch.includes('new') ? 'menambah agenda' : 'memperbarui agenda') + ` "${ev.title}"`;
  const what = ch.filter(c => CHANGE_LABEL[c]).map(c => CHANGE_LABEL[c]);
  if(!ch.includes('new') && what.length) s += ` (${what.join(', ')})`;
  if(ev.date){
    const tgl = new Date(ev.date + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
    s += ` — ${relDays(daysLeft(ev.date))}, ${tgl}` + (ev.time ? ` pukul ${ev.time.replace('.', ':')}` : '');
  }
  return s;
}
function eventText(ev){
  switch(ev.kind){
    case 'note': return 'menambah catatan';
    case 'timeline': return timelineText(ev);
    case 'vendor_status': return `memperbarui vendor ${ev.vendorKey}` + (ev.status ? ` → ${ev.status}` : '');
    case 'vendor_update': return `memperbarui info vendor ${ev.vendorKey}`;
    case 'attachment': return `meng-upload ${ev.what}` + (ev.detail ? ` "${ev.detail}"` : '');
    case 'moodboard': return 'memperbarui moodboard';
    case 'moodboard_note': return 'menambah catatan moodboard';
    default: return null;
  }
}
function sanitizeEvents(raw){
  const out = [];
  for(const e of (Array.isArray(raw) ? raw : []).slice(0, MAX_EVENTS)){
    if(!e || typeof e.kind !== 'string') continue;
    const ev = {
      kind: e.kind, vendorKey: clean(e.vendorKey, 40), status: clean(e.status, 30), what: clean(e.what, 20),
      key: clean(e.key, 60), detail: clean(e.detail, 60), title: clean(e.title, 60),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')) ? String(e.date) : '',
      time: /^\d{1,2}[:.]\d{2}$/.test(String(e.time || '')) ? String(e.time) : '',
      changes: (Array.isArray(e.changes) ? e.changes : []).filter(c => CHANGE_CODES.includes(c)).slice(0, 9)
    };
    if(!eventText({ ...ev, vendorKey: ev.vendorKey || '-', what: ev.what || '-' })) continue;
    if(ev.kind === 'attachment' && !DOC_WHITELIST.includes(ev.what)) continue;
    if((ev.kind === 'vendor_status' || ev.kind === 'vendor_update') && !ev.vendorKey) continue;
    out.push(ev);
  }
  return out;
}

/* Murni (tanpa Firebase) supaya bisa dites. Hasil: [{ docId, token, role, events:[ev] }] */
export function pickRecipients({ project, recs, schedule, events, actorRole, actorToken }){
  const pid = project.id;
  const vendorAccountsFor = key => {
    const ids = new Set();
    const v = project.vendors && project.vendors[key];
    if(v && v.vendorAccountId) ids.add(v.vendorAccountId);
    for(const e of (schedule || [])) if(e && e.projectId === pid && e.catLabel === key && e.vendorAccountId) ids.add(e.vendorAccountId);
    return ids;
  };
  const byToken = new Map();
  const add = (rec, ev) => {
    if(!rec.token || rec.token === actorToken) return;
    if(!byToken.has(rec.token)) byToken.set(rec.token, { docId: rec.docId, token: rec.token, role: rec.role, events: [] });
    byToken.get(rec.token).events.push(ev);
  };
  for(const rec of recs){
    for(const ev of events){
      let ok = false;
      if(rec.role === 'admin'){
        ok = (actorRole === 'client' || actorRole === 'vendor');
      } else if(rec.role === 'marketing'){
        ok = (actorRole === 'client' || actorRole === 'vendor' || actorRole === 'admin') && !!project.marketingId && rec.marketingId === project.marketingId;
      } else if(rec.role === 'client'){
        ok = rec.projectId === pid && (actorRole === 'admin' || actorRole === 'marketing' || actorRole === 'vendor');
      } else if(rec.role === 'vendor'){
        // vendor hanya diberi tahu soal statusnya sendiri yang diubah admin/marketing/klien
        if(ev.kind === 'vendor_status' && actorRole !== 'vendor'){
          if(rec.vendorAccountId) ok = vendorAccountsFor(ev.vendorKey).has(rec.vendorAccountId);
          else ok = rec.projectId === pid && rec.supplierKey === ev.vendorKey;
        }
      }
      if(ok) add(rec, ev);
    }
  }
  return [...byToken.values()];
}

export function buildMessage({ project, actorRole, actorVendorKey, events, url }){
  const couple = [project.couple && project.couple.brideName, project.couple && project.couple.groomName].filter(Boolean).join(' & ') || 'Project';
  const who = actorRole === 'vendor' && actorVendorKey ? `Vendor ${actorVendorKey}` : (ACTOR_LABEL[actorRole] || 'Seseorang');
  const lines = events.map(ev => '• ' + eventText(ev));
  const first = eventText(events[0]);
  return {
    title: `${couple}`,
    body: events.length === 1 ? `${who} ${first}` : `${who} melakukan ${events.length} pembaruan:\n${lines.slice(0, 5).join('\n')}`,
    tag: `evt-${project.id}-${events.length === 1 ? events[0].kind : 'multi'}`,
    url
  };
}

const recent = new Map(); // anti-spam ringan per instance serverless
export default async function handler(req, res){
  if(req.method !== 'POST'){ res.status(405).json({ error: 'POST only' }); return; }
  try{
    let body = req.body;
    if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
    body = body || {};
    const projectId = clean(body.projectId, 80);
    const actorRole = ['client','admin','marketing','vendor'].includes(body.actorRole) ? body.actorRole : '';
    const events = sanitizeEvents(body.events);
    if(!projectId || !actorRole || !events.length){ res.status(400).json({ error: 'payload tidak valid' }); return; }
    if(!process.env.FIREBASE_SERVICE_ACCOUNT){ res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel' }); return; }

    const sig = projectId + '|' + actorRole + '|' + events.map(e => [e.kind, e.vendorKey, e.what, e.key, e.title, e.date, e.time, e.detail, (e.changes || []).join('+')].join('~')).join(',');
    const now = Date.now();
    for(const [k, t] of recent) if(now - t > 20000) recent.delete(k);
    if(recent.has(sig)){ res.status(200).json({ ok: true, skipped: 'duplikat' }); return; }
    recent.set(sig, now);

    if(!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const col = getFirestore().collection(COLLECTION);

    const pSnap = await col.doc(PROJECT_KEY(projectId)).get();
    if(!pSnap.exists){ res.status(404).json({ error: 'project tidak ditemukan' }); return; }
    const project = JSON.parse(pSnap.data().value);
    project.id = projectId;

    const tokSnap = await col.where(FieldPath.documentId(), '>=', TOKEN_PREFIX)
                             .where(FieldPath.documentId(), '<', TOKEN_PREFIX + '').get();
    const recs = [];
    tokSnap.forEach(d => { try{ recs.push({ docId: d.id, ...JSON.parse(d.data().value) }); }catch(e){} });
    let schedule = [];
    try{ const s = await col.doc(SCHEDULE_KEY).get(); schedule = s.exists ? JSON.parse(s.data().value || '[]') : []; }catch(e){}

    const targets = pickRecipients({ project, recs, schedule, events, actorRole, actorToken: clean(body.actorToken, 400) });
    const base = String(process.env.APP_URL || (req.headers.host ? 'https://' + req.headers.host : '')).split('#')[0];
    let sent = 0, removed = 0, failed = 0, lastErr = '';
    const to = {}; // jumlah perangkat tujuan per peran, untuk diagnosa
    for(const t of targets) to[t.role] = (to[t.role] || 0) + 1;
    for(const t of targets.slice(0, 200)){
      const msg = buildMessage({ project, actorRole, actorVendorKey: clean(body.actorVendorKey, 40), events: t.events, url: base + (ROLE_HASH[t.role] || '') });
      try{
        await getMessaging().send({ token: t.token, data: msg, webpush: { headers: { Urgency: 'high', TTL: '3600' } } });
        sent++;
      }catch(e){
        if(e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token'){
          await col.doc(t.docId).delete().catch(()=>{}); removed++;
        } else { failed++; lastErr = String(e && e.code || e && e.message || e).slice(0, 80); }
      }
    }
    res.status(200).json({ ok: true, sent, removed, failed, to, ...(lastErr ? { err: lastErr } : {}) });
  }catch(e){
    console.error('notify gagal', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
