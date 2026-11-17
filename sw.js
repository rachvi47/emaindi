// Service worker: keeps the app files on the phone so the app opens instantly (even offline) and shows notifications.
const CACHE = "emaindi-v4";   // CHANGED: bumped so every phone drops the old broken cache and downloads a fresh one
const SHELL = ["./", "index.html", "index.js", "login.html", "login.js", "login-extra.css", "home.html", "home.js", "home.css", "chat.html", "chat.js", "chat.css", "common.js", "call.js", "settings.html", "style.css", "fire.js"];
// FIXED: the first entry was a broken markdown link, so the Firebase SDK was never cached.
// ADDED: common CDN hosts so the QR code / QR scanner libraries also load offline.
const CROSS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  if (!same && !CROSS.includes(url.hostname)) return;   // Firestore / Auth calls are never touched

  if (same) {
    // CHANGED (WhatsApp-style): open the saved copy instantly, and refresh it in the background.
    // New app versions appear the next time the app is opened.
    e.respondWith(
      caches.match(req, {ignoreSearch: true}).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        }).catch(() => null);
        if (hit) { e.waitUntil(net); return hit; }
        return net.then((res) => res || caches.match("home.html"));
      })
    );
  } else {
    // Firebase SDK, QR libraries and fonts are versioned: cache first
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type: "window", includeUncontrolled: true}).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return clients.openWindow("home.html");
    })
  );
});
