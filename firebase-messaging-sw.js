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

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification?.title || "Notifikasi ArtaJava";
  const notificationOptions = {
    body: payload.notification?.body || "Ada pembaruan baru.",
    icon: "/icon-192.png"
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
