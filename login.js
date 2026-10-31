// Login / sign-up page logic: email + password, phone number (OTP), Google.
// Google: native sign-in inside the Median.co app, popup in a normal browser.

import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "./fire.js";

const $ = (id) => document.getElementById(id);

const form = $("auth-form");
const tabLogin = $("tab-login");
const tabSignup = $("tab-signup");
const methodEmail = $("method-email");
const methodPhone = $("method-phone");
const nameField = $("name-field");
const nameInput = $("name");
const emailBlock = $("email-block");
const phoneBlock = $("phone-block");
const emailInput = $("email");
const passwordInput = $("password");
const forgotRow = $("forgot-row");
const phoneField = $("phone-field");
const phoneInput = $("phone");
const codeField = $("code-field");
const codeInput = $("code");
const codeHint = $("code-hint");
const submitBtn = $("submit");
const googleBtn = $("google");
const message = $("message");

let mode = "login";        // "login" | "signup"
let method = "email";      // "email" | "phone"
let phoneStep = "number";  // "number" | "code"
let busy = false;          // true while a sign-in is running (blocks the auto redirect)
let confirmation = null;   // result of signInWithPhoneNumber
let verifier = null;       // invisible reCAPTCHA
let phoneNumber = "";      // the number the code was sent to

// Already logged in? Skip this page.
onAuthStateChanged(auth, (user) => {
  if (user && !busy) window.location.replace("home.html");
});

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
  const phone = method === "phone";
  const codeStep = phone && phoneStep === "code";

  tabLogin.setAttribute("aria-selected", String(!signup));
  tabSignup.setAttribute("aria-selected", String(signup));
  methodEmail.setAttribute("aria-selected", String(!phone));
  methodPhone.setAttribute("aria-selected", String(phone));

  nameField.hidden = !signup || codeStep;
  emailBlock.hidden = phone;
  phoneBlock.hidden = !phone;
  phoneField.hidden = codeStep;
  codeField.hidden = !codeStep;
  forgotRow.hidden = signup;

  passwordInput.autocomplete = signup ? "new-password" : "current-password";

  $("title").textContent = signup ? "Create your account" : "Welcome back";
  $("subtitle").textContent = signup ? "It takes a minute." : "Log in to see your chats.";

  if (phone) {
    submitBtn.textContent = codeStep ? "Verify and continue" : "Send code";
  } else {
    submitBtn.textContent = signup ? "Create account" : "Log in";
  }

  googleBtn.textContent = "Continue with Google";
}

function setMode(next) {
  mode = next;
  show("");
  render();
}

function setMethod(next) {
  method = next;
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
    case "auth/invalid-phone-number":
    case "auth/missing-phone-number":
      return "That phone number doesn't look right. Include the country code, for example +91 98765 43210.";
    case "auth/quota-exceeded":
      return "The daily text message limit has been reached. Try again tomorrow or use a test number.";
    case "auth/invalid-verification-code":
    case "auth/missing-verification-code":
      return "That code is incorrect. Check it and try again.";
    case "auth/code-expired":
      return "That code has expired. Select Resend code.";
    case "auth/captcha-check-failed":
      return "The security check failed. Reload the page and try again.";
    case "auth/unauthorized-domain":
      return "This domain is not allowed. Add it under Authentication > Settings > Authorized domains.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google window. Allow pop-ups and try again.";
    case "auth/operation-not-supported-in-this-environment":
      return "Google sign-in isn't supported in this browser. Use the app or another browser.";
    case "auth/billing-not-enabled":
      return "Phone sign-in needs billing turned on for this Firebase project (Blaze plan). Use Email or Google for now.";
    case "auth/invalid-app-credential":
      return "The security check (reCAPTCHA) was rejected. Reload the page and try again.";
    case "google/native-failed":
      return err.message || "Google sign-in failed. Try again.";
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

/* ---------- Phone number (OTP) ---------- */

function normalizePhone(raw) {
  const cleaned = raw.replace(/[\s\-().]/g, "");
  return /^\+\d{8,15}$/.test(cleaned) ? cleaned : "";
}

function resetVerifier() {
  if (verifier) {
    try { verifier.clear(); } catch (_) { /* already cleared */ }
    verifier = null;
  }
  $("recaptcha-container").innerHTML = "";
}

async function requestCode(number) {
  busy = true;
  setLoading(true);
  show("");
  try {
    resetVerifier();
    verifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
    confirmation = await signInWithPhoneNumber(auth, number, verifier);
    phoneNumber = number;
    phoneStep = "code";
    codeInput.value = "";
    codeHint.textContent = "We sent a 6-digit code to " + number + ".";
    render();
    codeInput.focus();
  } catch (err) {
    resetVerifier();
    show(friendlyError(err));
  } finally {
    busy = false;
    setLoading(false);
  }
}

async function submitPhone() {
  if (phoneStep === "number") {
    const number = normalizePhone(phoneInput.value);
    if (!number) {
      return show("Enter your number with the country code, for example +91 98765 43210.");
    }
    if (mode === "signup" && !nameInput.value.trim()) return show("Enter your name.");
    return requestCode(number);
  }

  // Step 2: check the code
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) return show("Enter the 6-digit code.");

  busy = true;
  setLoading(true);
  show("");
  try {
    const cred = await confirmation.confirm(code);
    const name = nameInput.value.trim();
    if (name && !cred.user.displayName) {
      await updateProfile(cred.user, { displayName: name }).catch(() => {});
    }
    await ensureUserDoc(cred.user, name);
    window.location.replace("home.html");
  } catch (err) {
    busy = false;
    setLoading(false);
    show(friendlyError(err));
  }
}

$("resend").addEventListener("click", () => {
  if (phoneNumber) requestCode(phoneNumber);
});

$("change-number").addEventListener("click", () => {
  confirmation = null;
  phoneStep = "number";
  resetVerifier();
  show("");
  render();
  phoneInput.focus();
});

/* ---------- Continue with Google ---------- */

// Median (and the older GoNative) inject a JS bridge into the app's WebView.
function getNativeGoogle() {
  const bridge = window.median || window.gonative;
  return bridge && bridge.socialLogin && bridge.socialLogin.google
    ? bridge.socialLogin.google
    : null;
}

function nativeError(message) {
  const e = new Error(message);
  e.code = "google/native-failed";
  return e;
}

// Opens the native Google account picker and resolves with a Google ID token.
function nativeGoogleLogin(api) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const handle = (res) => {
      if (settled) return;
      settled = true;
      delete window.__googleLoginCallback;

      const data = typeof res === "string" ? safeParse(res) : res;
      const idToken = data && (data.idToken || data.id_token);

      if (idToken) return resolve(idToken);
      if (data && (data.error === "cancelled" || data.cancelled)) {
        const e = new Error("cancelled");
        e.code = "auth/popup-closed-by-user";
        return reject(e);
      }
      reject(nativeError((data && (data.error || data.message)) || "Google sign-in failed. Try again."));
    };

    window.__googleLoginCallback = handle;

    try {
      // Median accepts a callback name and also returns a promise in newer versions.
      const result = api.login({ callback: "__googleLoginCallback" });
      if (result && typeof result.then === "function") result.then(handle, (err) => {
        if (settled) return;
        settled = true;
        reject(nativeError(err && err.message));
      });
    } catch (err) {
      settled = true;
      reject(nativeError(err && err.message));
    }
  });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

googleBtn.addEventListener("click", async () => {
  busy = true;
  setLoading(true);
  show("");
  try {
    let cred;
    const native = getNativeGoogle();

    if (native) {
      // Inside the Android app: native sign-in, then hand the token to Firebase.
      const idToken = await nativeGoogleLogin(native);
      const credential = GoogleAuthProvider.credential(idToken);
      cred = await signInWithCredential(auth, credential);
    } else {
      // Normal browser: regular popup.
      cred = await signInWithPopup(auth, new GoogleAuthProvider());
    }

    await ensureUserDoc(cred.user);
    window.location.replace("home.html");
  } catch (err) {
    busy = false;
    setLoading(false);
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    show(friendlyError(err));
  }
});

/* ---------- Wiring ---------- */

tabLogin.addEventListener("click", () => setMode("login"));
tabSignup.addEventListener("click", () => setMode("signup"));
methodEmail.addEventListener("click", () => setMethod("email"));
methodPhone.addEventListener("click", () => setMethod("phone"));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) return;
  if (method === "phone") submitPhone();
  else submitEmail();
});

render();
