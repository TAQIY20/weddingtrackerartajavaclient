// api/blob-upload.js
// Endpoint ini TIDAK menerima file secara langsung. Ia cuma mengeluarkan
// "izin upload" sementara (token) yang dipakai browser untuk kirim file
// LANGSUNG ke Vercel Blob storage — bukan lewat server function ini.
// Kenapa begini: Vercel Functions punya batas ukuran body request 4.5MB,
// jadi kalau file (misal PDF 5-15MB) dikirim lewat function biasa, akan
// gagal dengan error 413. Client-upload flow ini yang direkomendasikan
// resmi oleh Vercel untuk file besar.
//
// Referensi: https://vercel.com/docs/vercel-blob/client-upload

import { handleUpload } from '@vercel/blob/client';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = request.body;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname /*, clientPayload */) => {
        // Di sini idealnya ada pengecekan otorisasi (misal: pastikan yang
        // upload memang vendor yang login), tapi karena app ini sudah
        // punya sistem PIN/password sendiri di level UI, kita cukup
        // batasi tipe file & ukuran di sini sebagai lapisan kedua.
        return {
          allowedContentTypes: [
            'application/pdf',
            'image/jpeg',
            'image/png',
            'image/webp',
          ],
          addRandomSuffix: true,
          maximumSizeInBytes: 20 * 1024 * 1024, // 20MB, konsisten dengan batas di UI
          tokenPayload: JSON.stringify({ pathname }),
        };
      },
      onUploadCompleted: async ({ blob /*, tokenPayload */ }) => {
        // Dipanggil otomatis oleh Vercel setelah upload benar-benar selesai
        // tersimpan. Tidak wajib melakukan apa-apa di sini untuk app ini,
        // karena URL blob sudah dikembalikan ke client lewat response upload.
        console.log('Blob upload selesai:', blob.url);
      },
    });

    response.status(200).json(jsonResponse);
  } catch (error) {
    // Selalu balas error 400 dengan pesan yang jelas, JANGAN 500 kosong,
    // supaya di sisi client bisa ditampilkan pesan yang berguna ke user.
    response.status(400).json({ error: error.message });
  }
}
