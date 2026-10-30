// api/blob-delete.js
// Hapus file dari Vercel Blob. Ini HARUS lewat server (bukan langsung dari
// browser) karena operasi delete butuh BLOB_READ_WRITE_TOKEN — token penuh
// yang tidak boleh dikirim/ditaruh di kode client.

import { del } from '@vercel/blob';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { url } = request.body;
    if (!url) {
      response.status(400).json({ error: 'Parameter "url" wajib diisi' });
      return;
    }
    await del(url);
    response.status(200).json({ deleted: true });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
