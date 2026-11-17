// push.js - notifications when the app is closed (Web Push). Used by home.js and settings.html.
// The browser gives each device a "subscription"; we save it in users/{uid}/devices/{id} (private to you),
// and a Cloud Function (functions/index.js) sends a push to those devices when a new message arrives.
import {db, doc, setDoc, serverTimestamp} from "./fire.js";
import {deleteDoc} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// >>> PASTE YOUR VAPID PUBLIC KEY HERE (made with: npx web-push generate-vapid-keys). It is safe to be public. <<<
export const VAPID_PUBLIC_KEY = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const configured = () => !VAPID_PUBLIC_KEY.startsWith("PASTE");
const flagKey = (uid) => "push:" + uid;
const flagOff = (uid) => { try { return localStorage.getItem(flagKey(uid)) === "0"; } catch (e) { return false; } };
const setFlag = (uid, on) => { try { localStorage.setItem(flagKey(uid), on ? "1" : "0"); } catch (e) {} };
// same key common.js uses for locked chats on this device
const lockedList = (uid) => { try { return JSON.parse(localStorage.getItem("locked:" + uid)) || []; } catch (e) { return []; } };

const toKey = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const sameKey = (sub, key) => {
  const k = sub.options && sub.options.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  return a.length === key.length && a.every((v, i) => v === key[i]);
};
async function deviceId(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function registration() {
  await navigator.serviceWorker.register("sw.js");   // safe to call again; makes sure the worker exists on every page
  return navigator.serviceWorker.ready;
}

let curUid = "";

// "unsupported" | "blocked" | "off" | "on"
export async function pushStatus(uid) {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted" || flagOff(uid)) return "off";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    return sub ? "on" : "off";
  } catch (e) { return "off"; }
}

// Turn notifications on for this device (asks permission if needed). Throws "unsupported", "not-configured" or "blocked".
export async function enablePush(uid) {
  if (!supported()) throw new Error("unsupported");
  if (!configured()) throw new Error("not-configured");
  curUid = uid;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") throw new Error("blocked");
  const reg = await registration(), key = toKey(VAPID_PUBLIC_KEY);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  await setDoc(doc(db, "users", uid, "devices", await deviceId(sub.endpoint)),
    {sub: sub.toJSON(), locked: lockedList(uid), updatedAt: serverTimestamp()}, {merge: true});
  setFlag(uid, true);
}

// Stop sending pushes to this device (used on log out). Keeps the user's on/off choice.
export async function detachPush(uid) {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    const id = await deviceId(sub.endpoint);
    await sub.unsubscribe();
    await deleteDoc(doc(db, "users", uid, "devices", id));
  } catch (e) { console.warn("Push detach:", e.message || e); }
}

// The user switched notifications off in Settings.
export async function disablePush(uid) { setFlag(uid, false); await detachPush(uid); }

// Called when a page opens: if notifications are already allowed, keep this device registered.
export async function initPush(uid) {
  curUid = uid;
  if (!supported() || !configured()) return;
  if (Notification.permission !== "granted" || flagOff(uid)) return;
  try { await enablePush(uid); } catch (e) { console.warn("Push setup:", e.message || e); }
}

// Locked chats show only "New message" in notifications, so the server needs to know which chats are locked on this device.
addEventListener("locks-changed", async () => {
  if (!curUid || !supported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await setDoc(doc(db, "users", curUid, "devices", await deviceId(sub.endpoint)), {locked: lockedList(curUid)}, {merge: true});
  } catch (e) {}
});
