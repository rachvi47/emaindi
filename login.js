// Login / sign-up page logic: email + password, and Google (which then asks for a password).

import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  EmailAuthProvider,
  linkWithCredential,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "./fire.js";

console.log("login.js loaded");

const HOME_PAGE = "home.html";

/* ---------- Find elements (and fail loudly if one is missing) ---------- */

const $ = (id) => document.getElementById(id);

const IDS = [
  "auth-form", "tab-login", "tab-signup", "name-field", "name", "email",
  "password", "forgot-row", "forgot", "submit", "google", "message",
  "pw-form", "pw-new", "pw-confirm", "pw-message", "pw-submit", "pw-cancel",
  "title", "subtitle",
];

const missing = IDS.filter((id) => !$(id));
if (missing.length) {
  const text = "Page setup problem. Missing element id(s): " + missing.join(", ");
  console.error(text);
  alert(text);
  throw new Error(text);
}

const form = $("auth-form");
const tabLogin = $("tab-login");
const tabSignup = $("tab-signup");
const nameField = $("name-field");
const nameInput = $("name");
const emailInput = $("email");
const passwordInput = $("password");
const forgotRow = $("forgot-row");
const forgotBtn = $("forgot");
const submitBtn = $("submit");
const googleBtn = $("google");
const message = $("message");
const pwForm = $("pw-form");
const pwNew = $("pw-new");
const pwConfirm = $("pw-confirm");
const pwMessage = $("pw-message");
const pwSubmit = $("pw-submit");
const pwCancel = $("pw-cancel");
const tabsEl = document.querySelector(".tabs");
const dividerEl = document.querySelector(".divider");

/* ---------- State ---------- */

let busy = false;      // true while a sign-in is running (blocks the auto redirect)
let pwUser = null;     // the Google user who is choosing a password
let mode = "login";    // "login" | "signup"

/* ---------- Helpers ---------- */

const hasPassword = (user) => user.providerData.some((p) => p.providerId === "password");
const needsPassword = (user) => !!user.email && !hasPassword(user);

function goHome() {
  window.location.replace(HOME_PAGE);
}

function show(text, type = "error") {
  message.textContent = text;
  message.className = "message " + (text ? type : "");
}

function pwShow(text) {
  pwMessage.textContent = text;
  pwMessage.className = "message " + (text ? "error" : "");
}

function setLoading(on) {
  submitBtn.disabled = on;
  googleBtn.disabled = on;
  forgotBtn.disabled = on;
}

function friendlyError(err) {
  switch (err && err.code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/missing-password":
      return "Enter your password.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "Email or password is incorrect.";
    case "auth/user-disabled":
      return "This account has been disabled.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Log in instead.";
    case "auth/weak-password":
      return "Use a password with at least 6 characters.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes and try again.";
    case "auth/network-request-failed":
      return "No connection. Check your internet and try again.";
    case "auth/operation-not-allowed":
      return "This sign-in method is turned off. Enable it in the Firebase console.";
    case "auth/unauthorized-domain":
      return "This domain is not allowed. Add it under Authentication > Settings > Authorized domains.";
    case "auth/invalid-api-key":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
      return "The Firebase API key in fire.js is wrong.";
    case "auth/app-deleted":
    case "auth/internal-error":
      return "Firebase is not set up correctly. Check fire.js and the Firebase console.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google window. Allow pop-ups and try again.";
    case "auth/account-exists-with-different-credential":
      return "An account with this email already exists. Log in with your email and password.";
    case "auth/requires-recent-login":
      return "For safety, log in with Google again, then set your password.";
    case "auth/provider-already-linked":
    case "auth/credential-already-in-use":
      return "This account already has a password. Log in with your email and password.";
    default:
      console.error(err);
      return "Something went wrong (" + ((err && (err.code || err.message)) || "unknown error") + ").";
  }
}

/* ---------- Google does not work inside an app WebView (Median / GoNative APK) ---------- */

const inAppWebView =
  /; wv\)|gonative|median/i.test(navigator.userAgent) || !!window.median || !!window.gonative;

if (inAppWebView) {
  googleBtn.hidden = true;
  if (dividerEl) dividerEl.hidden = true;
}

/* ---------- Catch any stray error and show it on screen ---------- */

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise error:", e.reason);
});

/* ---------- Firestore profile ---------- */

// Creates users/{uid} the first time someone signs in. A Firestore problem
// must never block the login itself, so errors are only logged.
async function saveProfile(user, name) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  await setDoc(ref, {
    uid: user.uid,
    name: name || user.displayName || "",
    email: user.email || "",
    phone: user.phoneNumber || "",
    photoUrl: user.photoURL || "",
    createdAt: serverTimestamp(),
  });
}

// If Firestore is not created yet, or is slow, give up after 4 seconds
// so the button never looks stuck.
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function ensureUserDoc(user, name = "") {
  try {
    await withTimeout(saveProfile(user, name), 4000);
  } catch (err) {
    console.error("Could not save the user profile:", err);
  }
}

/* ---------- Mode (login / sign-up) ---------- */

function render() {
  const signup = mode === "signup";

  tabLogin.setAttribute("aria-selected", String(!signup));
  tabSignup.setAttribute("aria-selected", String(signup));

  nameField.hidden = !signup;
  forgotRow.hidden = signup;

  passwordInput.autocomplete = signup ? "new-password" : "current-password";

  $("title").textContent = signup ? "Create your account" : "Welcome back";
  $("subtitle").textContent = signup ? "It takes a minute." : "Log in to see your chats.";

  submitBtn.textContent = signup ? "Create account" : "Log in";
}

function setMode(next) {
  mode = next;
  show("");
  render();
}

/* ---------- Already logged in? Skip this page ---------- */

onAuthStateChanged(
  auth,
  (user) => {
    if (!user || busy) return;
    // A Google account with no password yet must finish the password step first.
    if (needsPassword(user)) return showPasswordStep(user);
    goHome();
  },
  (err) => {
    console.error("Auth state error:", err);
    show(friendlyError(err));
  }
);

/* ---------- Email and password ---------- */

async function submitEmail() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  if (!email || !password) return show("Enter your email and password.");
  if (mode === "signup" && !name) return show("Enter your name.");
  if (mode === "signup" && password.length < 6) {
    return show("Use a password with at least 6 characters.");
  }

  busy = true;
  setLoading(true);
  show("");

  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await updateProfile(cred.user, { displayName: name });
      } catch (err) {
        console.error("Could not set the display name:", err);
      }
      await ensureUserDoc(cred.user, name);
    } else {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      // Old accounts may not have a profile document yet.
      await ensureUserDoc(cred.user);
    }
    goHome();
  } catch (err) {
    busy = false;
    setLoading(false);
    show(friendlyError(err));
  }
}

forgotBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) return show("Enter your email first, then select Forgot password.");
  forgotBtn.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    show(
      "If an account exists for " + email + ", a reset link is on its way. Check your spam folder too.",
      "ok"
    );
  } catch (err) {
    show(friendlyError(err));
  } finally {
    forgotBtn.disabled = false;
  }
});

/* ---------- Google ---------- */

googleBtn.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setLoading(true);
  show("");
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await ensureUserDoc(cred.user);
    if (needsPassword(cred.user)) {
      setLoading(false);
      showPasswordStep(cred.user); // stays busy so we do not redirect yet
    } else {
      goHome();
    }
  } catch (err) {
    busy = false;
    setLoading(false);
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    show(friendlyError(err));
  }
});

/* ---------- Password step after Google ---------- */

function showPasswordStep(user) {
  busy = true;
  pwUser = user;
  form.hidden = true;
  googleBtn.hidden = true;
  if (tabsEl) tabsEl.hidden = true;
  if (dividerEl) dividerEl.hidden = true;
  $("title").textContent = "One more step";
  $("subtitle").textContent = "Signed in as " + user.email;
  pwForm.hidden = false;
  pwNew.focus();
}

pwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pwUser || pwSubmit.disabled) return;

  const pw = pwNew.value;
  if (pw.length < 6) return pwShow("Use a password with at least 6 characters.");
  if (pw !== pwConfirm.value) return pwShow("The two passwords do not match.");

  pwSubmit.disabled = true;
  pwCancel.disabled = true;
  pwShow("");

  try {
    await linkWithCredential(pwUser, EmailAuthProvider.credential(pwUser.email, pw));
    goHome();
  } catch (err) {
    pwSubmit.disabled = false;
    pwCancel.disabled = false;
    pwShow(friendlyError(err));
  }
});

// Cancelling must not leave a half-made "Google only" account behind
// (it could never log in with email and password). Remove it if we can.
pwCancel.addEventListener("click", async () => {
  pwSubmit.disabled = true;
  pwCancel.disabled = true;
  try {
    if (pwUser) await pwUser.delete();
  } catch (err) {
    console.error("Could not delete the unfinished account:", err);
    try { await signOut(auth); } catch (_) { /* ignore */ }
  }
  window.location.reload();
});

/* ---------- Wiring ---------- */

tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  submitEmail();
});

render();
