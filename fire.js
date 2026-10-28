// fire.js - the single place where Firebase is set up.
// Every page imports auth / db (and the helper functions) from here.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  signOut,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  serverTimestamp,
  increment,
  arrayUnion,
  limit,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// >>> KEEP YOUR OWN VALUES HERE <<<
// Copy the firebaseConfig block from your old fire.js over this one.
const firebaseConfig = {
  apiKey: "AIzaSyCRgTq8NcndUzBK5tjYlr5DY8laa7_xpUU",
  authDomain: "emaindi-f5ea2.firebaseapp.com",
  projectId: "emaindi-f5ea2",
  storageBucket: "emaindi-f5ea2.firebasestorage.app",
  messagingSenderId: "704085002121",
  appId: "1:704085002121:web:c3c1ed0705cb5f35ac0358",
  measurementId: "G-F0PMN25BGD"
};


const app = initializeApp(firebaseConfig);
// Saved login: try IndexedDB first, then localStorage. Set up once here (not with setPersistence on every
// page load, which could race with restoring the saved user and log you out).
let auth;
try {
  auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
    popupRedirectResolver: browserPopupRedirectResolver,
  });
} catch (err) {
  auth = getAuth(app);
}
// Keeps recent chats, messages and users in this browser (IndexedDB), so the app opens fast
// and shows your chats even offline. Messages are cached as encrypted text, same as in Firestore.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (err) {
  console.warn("Offline cache not available, using normal mode:", err);
  db = getFirestore(app);
}


export {
  app,
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  signOut,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  GoogleAuthProvider,
  signInWithPopup,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  serverTimestamp,
  increment,
  arrayUnion,
  limit,
};
