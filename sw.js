/* ArtaJava Wedding Organizer — service worker (khusus notifikasi push).
   Sengaja TIDAK ada cache/fetch handler, supaya app (single-file HTML) selalu versi terbaru.
   Taruh 1 folder dengan index.html di hosting. */
importScripts('https://www.gstatic.com/firebasejs/12.17.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.17.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDPMCaEO1UmRK5VD8hlvQGoZALAmSYMwPQ",
  authDomain: "wedding-tracker-artajava-wo.firebaseapp.com",
  projectId: "wedding-tracker-artajava-wo",
  storageBucket: "wedding-tracker-artajava-wo.firebasestorage.app",
  messagingSenderId: "10890712516",
  appId: "1:10890712516:web:209a720114b51e7cf98091"
});

const messaging = firebase.messaging();

/* Pesan dari server berupa "data-only", jadi tampilannya (ikon, badge, judul) kita atur sendiri di sini. */
messaging.onBackgroundMessage(function(payload){
  const d = payload.data || {};
  const base = self.registration.scope;
  return self.registration.showNotification(d.title || 'ArtaJava Wedding Organizer', {
    body: d.body || '',
    icon: base + 'icons/icon-192.png',
    badge: base + 'icons/badge-96.png',
    tag: d.tag || undefined,
    data: { url: d.url || base }
  });
});

/* Klik notif: fokus ke tab app yang sudah terbuka, kalau tidak ada baru buka tab baru. */
self.addEventListener('notificationclick', function(event){
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for(const c of list){
        if(c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
