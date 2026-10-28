const MIN_SPLASH_MS = 8000;
const FIREBASE_TIMEOUT_MS = 10000; // slow phones can take a while to restore the saved login

window.__redirecting = true; // tells the safety net in index.html that this script loaded

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  try { if (localStorage.getItem("lastUid")) return window.location.replace("home.html"); } catch (e) {}   // logged in before: open chats at once
  const minWait = new Promise((r) => setTimeout(r, MIN_SPLASH_MS));
  let user = null;

  try {
    const { auth } = await import("./fire.js");
    user = await Promise.race([
      (async () => {
        // wait until Firebase has finished restoring the saved login, then read it
        if (auth.authStateReady) await auth.authStateReady();
        return auth.currentUser;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(null), FIREBASE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error("Firebase failed to load:", err);
  }

  await minWait;
  window.location.replace(user ? "home.html" : "login.html");
})();
