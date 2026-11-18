// Splash screen: wait for Firebase to restore the saved session,
// then route authenticated users to chats and everyone else to login.
import { auth, onAuthStateChanged } from "./fire.js";

let routed = false;

function route(user) {
  if (routed) return;
  routed = true;
  window.__redirecting = true;
  window.location.replace(user ? "home.html" : "login.html");
}

onAuthStateChanged(
  auth,
  (user) => route(user),
  (error) => {
    console.error("Could not restore authentication state:", error);
    route(null);
  }
);
