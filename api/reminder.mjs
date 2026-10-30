/* Endpoint Vercel (dipanggil Vercel Cron tiap pagi): kirim reminder push OTOMATIS tanpa menunggu ada yang edit.
   Isi reminder: agenda mendekat, pembayaran jatuh tempo/terlambat, hari-H acara, dan follow-up leads.
   Env di Vercel: FIREBASE_SERVICE_ACCOUNT (sudah ada), opsional CRON_SECRET (kalau diisi, endpoint hanya bisa dipanggil
   Vercel Cron / pemegang secret), opsional APP_URL. Tes tanpa kirim: /api/reminder?dry=1 (dengan header Authorization jika ada secret). */
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldPath } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const COLLECTION = 'wedding_kv';
const APP_VERSION = 'v4';
const PROJECT_PREFIX = 'wedding_project_' + APP_VERSION + '_';
const LEADS_KEY = 'wedding_leads_list_' + APP_VERSION;
const PAMERAN_KEY = 'wedding_pameran_list_' + APP_VERSION;
const TOKEN_PREFIX = 'push_token_';
const ROLE_HASH = { admin:'#admin', marketing:'#marketing', client:'#clientlink', vendor:'#vendorlink' };

const AGENDA_DAYS = [7, 3, 1, 0];          // pengingat agenda: H-7, H-3, H-1, hari H
const PAY_DAYS = [7, 3, 1, 0, -1, -3, -7]; // pembayaran: sebelum jatuh tempo + terlambat H+1/H+3/H+7
const WEDDING_DAYS = [30, 7, 3, 1, 0];     // hari acara pernikahan
const MAX_LINES = 6;

export const wibToday = (now = Date.now()) => new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
const diffDays = (iso, today) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const fmtDate = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday:'long', day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
const rp = n => 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
const rel = n => n === 0 ? 'hari ini' : n === 1 ? 'besok' : n > 1 ? `${n} hari lagi` : `sudah lewat ${-n} hari`;
const timeTxt = t => /^\d{1,2}[:.]\d{2}$/.test(String(t || '')) ? ' pukul ' + String(t).replace('.', ':') : '';
const coupleOf = p => [p.couple && p.couple.brideName, p.couple && p.couple.groomName].filter(Boolean).join(' & ') || 'Project';

/* Murni (tanpa Firebase) supaya bisa dites.
   Hasil: [{ audience:'project'|'lead', projectId?, marketingId?, couple?, line, clientLine }] */
export function buildReminders({ projects, leads, pamerans, today }){
  const out = [];
  for(const p of projects){
    if(!p || !p.id || !p.couple) continue;
    const couple = coupleOf(p);
    const base = { audience:'project', projectId:p.id, marketingId:p.marketingId || null, couple };
    // 1) hari acara
    if(isIso(p.couple.weddingDate)){
      const n = diffDays(p.couple.weddingDate, today);
      if(WEDDING_DAYS.includes(n)){
        const tgl = fmtDate(p.couple.weddingDate);
        out.push({ ...base, key:'wedding', line: `Acara pernikahan ${rel(n)} (${tgl})`,
          clientLine: n === 0 ? `Hari ini hari bahagia kalian! Selamat menikah (${tgl}) 🎉` : `Acara pernikahanmu ${rel(n)} — ${tgl}` });
      }
    }
    // 2) agenda timeline yang belum selesai
    for(const t of (p.timeline || [])){
      if(!t || t.status === 'done' || !isIso(t.date)) continue;
      const n = diffDays(t.date, today);
      if(!AGENDA_DAYS.includes(n)) continue;
      const title = String(t.title || 'Agenda').slice(0, 60);
      const tail = `${rel(n)}, ${fmtDate(t.date)}${timeTxt(t.time)}` + (t.location ? ` · ${String(t.location).slice(0, 50)}` : '');
      out.push({ ...base, key:'ag:' + t.id, line: `Agenda "${title}" ${tail}`, clientLine: `Agenda "${title}" ${tail}` });
    }
    // 3) pembayaran belum lunas
    for(const pay of (p.payments || [])){
      if(!pay || pay.status === 'paid' || !isIso(pay.dueDate)) continue;
      const n = diffDays(pay.dueDate, today);
      if(!PAY_DAYS.includes(n)) continue;
      const label = String(pay.label || 'Pembayaran').slice(0, 50);
      const amt = Number(pay.amount) > 0 ? ` ${rp(pay.amount)}` : '';
      const when = n < 0 ? `terlambat ${-n} hari (jatuh tempo ${fmtDate(pay.dueDate)})` : n === 0 ? `jatuh tempo hari ini` : `jatuh tempo ${rel(n)} (${fmtDate(pay.dueDate)})`;
      out.push({ ...base, key:'pay:' + pay.id, line: `Pembayaran "${label}"${amt} ${when}`,
        clientLine: n < 0 ? `Pengingat: pembayaran "${label}"${amt} sudah ${-n} hari melewati jatuh tempo` : `Pengingat: pembayaran "${label}"${amt} ${when}` });
    }
  }
  // 4) follow-up leads (H+1, H+3, H+7, lalu H+1..6 bulan) — hanya untuk staff
  const pameranEnd = id => { const x = (pamerans || []).find(q => q && q.id === id); return x ? (x.endDate || '') : ''; };
  for(const l of (leads || [])){
    if(!l || !l.name || l.stage === 'deal' || l.stage === 'batal') continue;
    let start = l.leadDate || String(l.createdAt || '').slice(0, 10);
    if(!isIso(start)) continue;
    const end = l.pameranId ? pameranEnd(l.pameranId) : (l.pameranEndDate || '');
    if(isIso(end) && end >= start) start = end; // nurture dihitung setelah pameran selesai
    const steps = [['h1','H+1', addDays(start,1)], ['h3','H+3', addDays(start,3)], ['h7','H+7', addDays(start,7)],
      ...[1,2,3,4,5,6].map(m => ['m' + m, `H+${m} Bulan`, addMonths(start, m)])];
    for(const [key, label, date] of steps){
      if(date !== today || (l.sentReminders && l.sentReminders[key])) continue;
      out.push({ audience:'lead', marketingId:l.picId || l.marketingId || null, key:'lead:' + (l.id || l.name) + ':' + key,
        line: `Follow up leads ${String(l.name).slice(0, 40)} (${label})` });
    }
  }
  return out;
}

/* Kelompokkan reminder per perangkat (token). Admin: semua. Marketing: project/leads miliknya. Klien: project-nya. */
export function groupByToken({ reminders, recs }){
  const byToken = new Map();
  const put = (rec, line) => {
    if(!rec.token) return;
    if(!byToken.has(rec.token)) byToken.set(rec.token, { docId:rec.docId, token:rec.token, role:rec.role, lines:[] });
    byToken.get(rec.token).lines.push(line);
  };
  for(const rec of recs){
    for(const r of reminders){
      if(rec.role === 'admin'){
        put(rec, r.audience === 'project' ? `${r.couple}: ${r.line}` : r.line);
      } else if(rec.role === 'marketing'){
        if(rec.marketingId && r.marketingId === rec.marketingId) put(rec, r.audience === 'project' ? `${r.couple}: ${r.line}` : r.line);
      } else if(rec.role === 'client'){
        if(r.audience === 'project' && rec.projectId === r.projectId) put(rec, r.clientLine);
      }
    }
  }
  return [...byToken.values()];
}

export function buildReminderMessage(t, url){
  const n = t.lines.length;
  const body = n === 1 ? t.lines[0] : t.lines.slice(0, MAX_LINES).map(l => '• ' + l).join('\n') + (n > MAX_LINES ? `\n…dan ${n - MAX_LINES} lainnya` : '');
  return { title: n === 1 ? 'Pengingat ArtaJava' : `Pengingat ArtaJava (${n})`, body, tag: 'reminder-' + t.role + '-' + wibToday(), url };
}

const parseDoc = d => { try{ return JSON.parse(d.data().value); }catch(e){ return null; } };

export default async function handler(req, res){
  try{
    const secret = process.env.CRON_SECRET;
    if(secret && req.headers.authorization !== 'Bearer ' + secret){ res.status(401).json({ error: 'unauthorized' }); return; }
    if(!process.env.FIREBASE_SERVICE_ACCOUNT){ res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel' }); return; }
    const dry = String((req.query && req.query.dry) || '') === '1';
    const today = wibToday();

    if(!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    const col = getFirestore().collection(COLLECTION);

    const projSnap = await col.where(FieldPath.documentId(), '>=', PROJECT_PREFIX).where(FieldPath.documentId(), '<', PROJECT_PREFIX + '\uf8ff').get();
    const projects = [];
    projSnap.forEach(d => { const p = parseDoc(d); if(p && p.couple){ p.id = d.id.slice(PROJECT_PREFIX.length); projects.push(p); } });
    const readList = async key => { try{ const s = await col.doc(key).get(); const v = s.exists ? JSON.parse(s.data().value || '[]') : []; return Array.isArray(v) ? v : []; }catch(e){ return []; } };
    const [leads, pamerans] = await Promise.all([readList(LEADS_KEY), readList(PAMERAN_KEY)]);

    const reminders = buildReminders({ projects, leads, pamerans, today });
    const tokSnap = await col.where(FieldPath.documentId(), '>=', TOKEN_PREFIX).where(FieldPath.documentId(), '<', TOKEN_PREFIX + '\uf8ff').get();
    const recs = [];
    tokSnap.forEach(d => { const r = parseDoc(d); if(r) recs.push({ docId: d.id, ...r }); });

    const targets = groupByToken({ reminders, recs });
    const base = String(process.env.APP_URL || (req.headers.host ? 'https://' + req.headers.host : '')).split('#')[0];
    if(dry){ res.status(200).json({ ok:true, dry:true, today, reminders: reminders.length, devices: recs.length, targets: targets.map(t => ({ role:t.role, ...buildReminderMessage(t, base) })) }); return; }

    let sent = 0, removed = 0, failed = 0;
    for(const t of targets.slice(0, 300)){
      try{
        await getMessaging().send({ token: t.token, data: buildReminderMessage(t, base + (ROLE_HASH[t.role] || '')), webpush: { headers: { Urgency: 'high', TTL: '43200' } } });
        sent++;
      }catch(e){
        if(e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token'){
          await col.doc(t.docId).delete().catch(() => {}); removed++;
        } else failed++;
      }
    }
    res.status(200).json({ ok:true, today, reminders: reminders.length, devices: recs.length, sent, removed, failed });
  }catch(e){
    console.error('reminder gagal', e);
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
