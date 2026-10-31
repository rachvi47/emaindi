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

const $ = (id) => document.getElementById(id);

const form = $("auth-form");
const tabLogin = $("tab-login");
const tabSignup = $("tab-signup");
const nameField = $("name-field");
const nameInput = $("name");
const emailInput = $("email");
const passwordInput = $("password");
const forgotRow = $("forgot-row");
const submitBtn = $("submit");
const googleBtn = $("google");

// Google refuses to sign people in inside an app WebView (like a Median.co APK), so hide the button there.
// Email sign-in still works in the app.
if (/; wv\)|gonative|median/i.test(navigator.userAgent) || window.median || window.gonative) {
  googleBtn.hidden = true;
  const dv = document.querySelector(".divider");
  if (dv) dv.hidden = true;
}
const message = $("message");
const pwForm = $("pw-form");
const pwNew = $("pw-new");
const pwConfirm = $("pw-confirm");
const pwMessage = $("pw-message");
const pwSubmit = $("pw-submit");

let busy = false;        // true while a sign-in is running (blocks the auto redirect)
let pwUser = null;        // the Google user who is choosing a password

let mode = "login";        // "login" | "signup"

// Already logged in? Skip this page.
onAuthStateChanged(auth, (user) => {
  if (!user || busy) return;
  // A Google account with no password yet must finish the password step first.
  if (needsPassword(user)) return showPasswordStep(user);
  window.location.replace("home.html");
});

const hasPassword = (user) => user.providerData.some((p) => p.providerId === "password");
const needsPassword = (user) => !!user.email && !hasPassword(user);

/* ---------- UI helpers ---------- */

function show(text, type = "error") {
  message.textContent = text;
  message.className = "message " + (text ? type : "");
}

function setLoading(on) {
  submitBtn.disabled = on;
  googleBtn.disabled = on;
}

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

function friendlyError(err) {
  switch (err.code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email or password is incorrect.";
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
    case "auth/popup-blocked":
      return "Your browser blocked the Google window. Allow pop-ups and try again.";
    case "auth/requires-recent-login":
      return "For safety, log in with Google again, then set your password.";
    case "auth/provider-already-linked":
    case "auth/credential-already-in-use":
      return "This account already has a password. Log in with your email and password.";
    default:
      console.error(err);
      return "Something went wrong (" + (err.code || err.message) + ").";
  }
}

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

/* ---------- Email and password ---------- */

async function submitEmail() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  if (!email || !password) return show("Enter your email and password.");
  if (mode === "signup" && !name) return show("Enter your name.");

  busy = true;
  setLoading(true);
  show("");

  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
      await ensureUserDoc(cred.user, name);
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    window.location.replace("home.html");
  } catch (err) {
    busy = false;
    setLoading(false);
    show(friendlyError(err));
  }
}

$("forgot").addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) return show("Enter your email first, then select Forgot password.");
  try {
    await sendPasswordResetEmail(auth, email);
    show("If an account exists for " + email + ", a reset link is on its way. Check your spam folder too.", "ok");
  } catch (err) {
    show(friendlyError(err));
  }
});

/* ---------- Google ---------- */

googleBtn.addEventListener("click", async () => {
  busy = true;
  setLoading(true);
  show("");
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await ensureUserDoc(cred.user);
    if (needsPassword(cred.user)) {
      setLoading(false);
      showPasswordStep(cred.user);   // stays busy so we do not redirect yet
    } else {
      window.location.replace("home.html");
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
  document.querySelector(".tabs").hidden = true;
  document.querySelector(".divider").hidden = true;
  $("title").textContent = "One more step";
  $("subtitle").textContent = "Signed in as " + user.email;
  pwForm.hidden = false;
  pwNew.focus();
}

function pwShow(text) {
  pwMessage.textContent = text;
  pwMessage.className = "message " + (text ? "error" : "");
}

pwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pwUser || pwSubmit.disabled) return;
  const pw = pwNew.value;
  if (pw.length < 6) return pwShow("Use a password with at least 6 characters.");
  if (pw !== pwConfirm.value) return pwShow("The two passwords do not match.");

  pwSubmit.disabled = true;
  pwShow("");
  try {
    await linkWithCredential(pwUser, EmailAuthProvider.credential(pwUser.email, pw));
    window.location.replace("home.html");
  } catch (err) {
    pwSubmit.disabled = false;
    pwShow(friendlyError(err));
  }
});

$("pw-cancel").addEventListener("click", async () => {
  try { await signOut(auth); } catch (_) { /* ignore */ }
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
