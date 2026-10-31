/* Manifest PWA per peran: /api/manifest?role=admin|marketing|client|vendor
   Dibaca iOS saat "Add to Home Screen", jadi ikon yang terpasang membuka peran yang sama. */
const MAP = {
  admin:     { h: '#admin',      n: 'Admin' },
  marketing: { h: '#marketing',  n: 'Marketing' },
  client:    { h: '#clientlink', n: 'Klien' },
  vendor:    { h: '#vendorlink', n: 'Vendor' }
};

export default async function handler(req, res) {
  try {
    const q = (req.query && req.query.role) || '';
    const role = MAP[q] ? q : 'admin';
    const r = MAP[role];
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const origin = proto + '://' + req.headers.host;
    const resp = await fetch(origin + '/manifest.webmanifest');
    if (!resp.ok) throw new Error('manifest dasar tidak ditemukan');
    const m = await resp.json();
    m.name = 'ArtaJava ' + r.n;
    m.short_name = 'ArtaJava ' + r.n;
    delete m.id; /* sama seperti manifest lama: tanpa id, iOS memakai start_url sebagai identitas */
    m.scope = origin + '/';
    m.start_url = origin + '/' + (role !== 'admin' ? '?r=' + role : '') + r.h;
    if (Array.isArray(m.icons)) m.icons.forEach(i => { i.src = new URL(i.src, origin + '/').href; });
    delete m.shortcuts;
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(JSON.stringify(m));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
