// Service worker: keeps the app files in cache (works offline) and shows notifications.
const CACHE = "emaindi-v3";
const SHELL = ["./", "index.html", "index.js", "login.html", "login.js", "login-extra.css", "home.html", "home.js", "home.css", "chat.html", "chat.js", "chat.css", "common.js", "call.js", "settings.html", "style.css", "fire.js"];
const CROSS = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

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
    // network first (so updates show immediately), cache when offline
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, {ignoreSearch: true}).then((r) => r || caches.match("home.html")))
    );
  } else {
    // Firebase SDK + fonts are versioned: cache first
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
