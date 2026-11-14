// Login / sign-up page logic:
// Email + password, phone OTP, Google (Website + Median APK).

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

let mode = "login";
let method = "email";
let phoneStep = "number";
let busy = false;
let confirmation = null;
let verifier = null;
let phoneNumber = "";

// Detect Median Android / iOS application
function isMedianApp() {
  return navigator.userAgent.toLowerCase().includes("median");
}

// Already logged in? Skip this page.
onAuthStateChanged(auth, (user) => {
  if (user && !busy) {
    window.location.replace("home.html");
  }
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

  passwordInput.autocomplete = signup
    ? "new-password"
    : "current-password";

  $("title").textContent = signup
    ? "Create your account"
    : "Welcome back";

  $("subtitle").textContent = signup
    ? "It takes a minute."
    : "Log in to see your chats.";

  if (phone) {
    submitBtn.textContent = codeStep
      ? "Verify and continue"
      : "Send code";
  } else {
    submitBtn.textContent = signup
      ? "Create account"
      : "Log in";
  }
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

/* ---------- Error handling ---------- */

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
      return "This sign-in method is turned off. Enable it in Firebase.";

    case "auth/invalid-phone-number":
    case "auth/missing-phone-number":
      return "Enter your phone number with country code.";

    case "auth/quota-exceeded":
      return "SMS limit reached. Try again later.";

    case "auth/invalid-verification-code":
    case "auth/missing-verification-code":
      return "That code is incorrect. Check it and try again.";

    case "auth/code-expired":
      return "That code has expired. Select Resend code.";

    case "auth/captcha-check-failed":
      return "The security check failed. Reload the page.";

    case "auth/unauthorized-domain":
      return "This domain is not authorized in Firebase.";

    case "auth/popup-blocked":
      return "Your browser blocked the Google login window.";

    case "auth/billing-not-enabled":
      return "Phone sign-in requires billing to be enabled.";

    case "auth/invalid-app-credential":
      return "The security check was rejected. Try again.";

    default:
      console.error("Authentication error:", err);
      return err.message || "Something went wrong. Please try again.";
  }
}

/* ---------- Firestore profile ---------- */

// Creates users/{uid} for new users.
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

async function ensureUserDoc(user, name = "") {
  try {
    await withTimeout(saveProfile(user, name), 4000);
  } catch (err) {
    console.error("Could not save user profile:", err);
  }
}

/* ---------- Email and password ---------- */

async function submitEmail() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();

  if (!email || !password) {
    return show("Enter your email and password.");
  }

  if (mode === "signup" && !name) {
    return show("Enter your name.");
  }

  busy = true;
  setLoading(true);
  show("");

  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      await updateProfile(cred.user, {
        displayName: name,
      });

      await ensureUserDoc(cred.user, name);

    } else {
      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );
    }

    window.location.replace("home.html");

  } catch (err) {
    busy = false;
    setLoading(false);
    show(friendlyError(err));
  }
}

/* ---------- Forgot password ---------- */

$("forgot").addEventListener("click", async () => {
  const email = emailInput.value.trim();

  if (!email) {
    return show(
      "Enter your email first, then select Forgot password."
    );
  }

  try {
    await sendPasswordResetEmail(auth, email);

    show(
      "If an account exists for " + email +
      ", a reset link is on its way. Check your spam folder too.",
      "ok"
    );

  } catch (err) {
    show(friendlyError(err));
  }
});

/* ---------- Phone number (OTP) ---------- */

function normalizePhone(raw) {
  const cleaned = raw.replace(/[\s\-().]/g, "");

  return /^\+\d{8,15}$/.test(cleaned)
    ? cleaned
    : "";
}

function resetVerifier() {
  if (verifier) {
    try {
      verifier.clear();
    } catch (_) {
      // Already cleared
    }

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

    verifier = new RecaptchaVerifier(
      auth,
      "recaptcha-container",
      { size: "invisible" }
    );

    confirmation = await signInWithPhoneNumber(
      auth,
      number,
      verifier
    );

    phoneNumber = number;
    phoneStep = "code";
    codeInput.value = "";

    codeHint.textContent =
      "We sent a 6-digit code to " + number + ".";

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
      return show(
        "Enter your number with country code, for example +91 98765 43210."
      );
    }

    if (mode === "signup" && !nameInput.value.trim()) {
      return show("Enter your name.");
    }

    return requestCode(number);
  }

  const code = codeInput.value.trim();

  if (!/^\d{6}$/.test(code)) {
    return show("Enter the 6-digit code.");
  }

  if (!confirmation) {
    return show("Request a new verification code.");
  }

  busy = true;
  setLoading(true);
  show("");

  try {
    const cred = await confirmation.confirm(code);

    const name = nameInput.value.trim();

    if (name && !cred.user.displayName) {
      await updateProfile(cred.user, {
        displayName: name,
      }).catch(() => {});
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
  if (phoneNumber) {
    requestCode(phoneNumber);
  }
});

$("change-number").addEventListener("click", () => {
  confirmation = null;
  phoneStep = "number";

  resetVerifier();
  show("");
  render();

  phoneInput.focus();
});

/* ---------- Google Login: Website + Median APK ---------- */

// Native Google callback from Median
async function medianGoogleCallback(response) {
  try {
    console.log("Median Google callback:", response);

    if (response?.error) {
      throw new Error(response.error);
    }

    if (!response?.idToken) {
      throw new Error(
        "Google ID token was not received from Median."
      );
    }

    // Create Firebase Google credential
    const googleCredential =
      GoogleAuthProvider.credential(response.idToken);

    // Authenticate with existing Firebase project
    const result = await signInWithCredential(
      auth,
      googleCredential
    );

    // Save new user profile if needed
    await ensureUserDoc(result.user);

    window.location.replace("home.html");

  } catch (err) {
    console.error("Median Google login error:", err);

    busy = false;
    setLoading(false);

    show(friendlyError(err));
  }
}

// Google login button handler
googleBtn.addEventListener("click", async () => {
  if (busy) return;

  busy = true;
  setLoading(true);
  show("");

  try {
    if (isMedianApp()) {

      // MEDIAN NATIVE GOOGLE LOGIN

      if (
        !window.median ||
        !window.median.socialLogin ||
        !window.median.socialLogin.google ||
        typeof window.median.socialLogin.google.login !== "function"
      ) {
        throw new Error(
          "Median Social Login plugin is unavailable. Enable Google Social Login in Median App Studio and rebuild your APK."
        );
      }

      // Open native Google account selection
      window.median.socialLogin.google.login({
        callback: medianGoogleCallback
      });

      // Wait for Median callback.
      // Do not reset busy here.

    } else {

      // NORMAL WEBSITE GOOGLE LOGIN

      const provider = new GoogleAuthProvider();

      const result = await signInWithPopup(
        auth,
        provider
      );

      await ensureUserDoc(result.user);

      window.location.replace("home.html");
    }

  } catch (err) {
    console.error("Google login error:", err);

    busy = false;
    setLoading(false);

    show(friendlyError(err));
  }
});

/* ---------- Wiring ---------- */

tabLogin.addEventListener("click", () => {
  setMode("login");
});

tabSignup.addEventListener("click", () => {
  setMode("signup");
});

methodEmail.addEventListener("click", () => {
  setMethod("email");
});

methodPhone.addEventListener("click", () => {
  setMethod("phone");
});

form.addEventListener("submit", (e) => {
  e.preventDefault();

  if (busy) return;

  if (method === "phone") {
    submitPhone();
  } else {
    submitEmail();
  }
});

// Initial UI
render();
