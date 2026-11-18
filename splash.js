// Firebase-aware splash screen. Keep the branded screen visible for at least 2s,
// but never wait longer than 5s if Firebase cannot restore authentication.
import { auth, onAuthStateChanged } from "./fire.js";

const startedAt = performance.now();
const MIN_SPLASH_MS = 2000;
const MAX_SPLASH_MS = 5000;
let routed = false;
let authResolved = false;
let resolvedUser = null;

function route(user) {
  if (routed) return;
  routed = true;
  window.location.replace(user ? "home.html" : "login.html");
}

function finishWhenReady(user) {
  const remaining = Math.max(0, MIN_SPLASH_MS - (performance.now() - startedAt));
  window.setTimeout(() => route(user), remaining);
}

const timeoutId = window.setTimeout(() => {
  if (!authResolved) {
    console.warn("Firebase auth restore timed out; continuing to login.");
    route(auth.currentUser || null);
  }
}, MAX_SPLASH_MS);

onAuthStateChanged(
  auth,
  (user) => {
    if (routed) return;
    authResolved = true;
    window.clearTimeout(timeoutId);
    resolvedUser = user;
    finishWhenReady(resolvedUser);
  },
  (error) => {
    console.error("Could not restore authentication state:", error);
    authResolved = true;
    window.clearTimeout(timeoutId);
    finishWhenReady(null);
  }
);
