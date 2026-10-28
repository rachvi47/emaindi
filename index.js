const MIN_SPLASH_MS = 2000;
const FIREBASE_TIMEOUT_MS = 4000;

window.__redirecting = true; // tells the safety net in index.html that this script loaded

(async () => {
  const minWait = new Promise((r) => setTimeout(r, MIN_SPLASH_MS));
  let user = null;

  try {
    const { auth, onAuthStateChanged } = await import("fire.js");
    user = await Promise.race([
      new Promise((resolve) => {
        const stop = onAuthStateChanged(auth, (u) => { stop(); resolve(u); });
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), FIREBASE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error("Firebase failed to load:", err);
  }

  await minWait;
  window.location.replace(user ? "home.html" : "login.html");
})();