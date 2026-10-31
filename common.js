// common.js - code shared by home.html (chat list) and chat.html (one conversation).
import {auth,db,onAuthStateChanged,doc,getDoc,setDoc,updateDoc,addDoc,collection,query,where,orderBy,onSnapshot,getDocs,serverTimestamp,increment,arrayUnion,limit} from "./fire.js";

export const $ = (s) => document.querySelector(s);
export const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
export const hm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
export const hidden = (u) => !!(u && u.settings && u.settings.hideOnline);
export const online = (u) => !!(u && !hidden(u) && u.online && Date.now() - ms(u.lastActive) < 60000);
export const lsFlag = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (e) { return d; } };

// Shared state. `me`, `chats` are live bindings: other files can read them but only this file changes them.
export let me = null, chats = [];
export const people = {}, contacts = {}, watching = {};
const mySet = () => (me && people[me.uid] && people[me.uid].settings) || {};

// Each page plugs its own screen-drawing functions in here.
export const hooks = {
  render() {}, meChanged() {}, chatsChanged() {}, peerChanged() {}, redecrypt() {},
  viewing() { return null; }, chatDeleted() {}, chatLockChanged() {},
};

/* ---------- small UI helpers (alert/prompt can be blocked inside an app WebView) ---------- */
let toastT;
export function toast(t) {
  const m = $("#toast"); if (!m) return;
  m.textContent = t; m.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (m.hidden = true), 3200);
}
export function dialog({title, text = "", input = "", value = "", ok = "OK", cancel = "Cancel", danger = false}) {
  return new Promise((res) => {
    const d = $("#dlg");
    d.innerHTML = `<div class="dbox"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}${input ? `<input id="dIn" type="${input}" value="${esc(value)}" autocomplete="off">` : ""}<div class="dact">${cancel ? '<button data-a="c">' + esc(cancel) + "</button>" : ""}<button data-a="o" class="${danger ? "dng" : ""}">${esc(ok)}</button></div></div>`;
    d.hidden = false;
    const inp = $("#dIn"), done = (v) => { d.hidden = true; d.onclick = null; res(v); };
    if (inp) { inp.focus(); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(inp.value); }); }
    d.onclick = (e) => { const a = e.target.dataset.a; if (a === "o") done(inp ? inp.value : true); else if (a === "c" || (e.target === d && cancel)) done(null); };
  });
}

/* theme from Settings (dark / light) */
function applyTheme() {
  let t = "light"; try { t = localStorage.getItem("theme") || "light"; } catch (e) {}
  document.documentElement.dataset.theme = t;
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "dark" ? "#0b1220" : "#14213D";
}
applyTheme();
addEventListener("pageshow", applyTheme);
addEventListener("focus", applyTheme);
addEventListener("storage", applyTheme);

/* message sound from Settings */
let actx = null;
addEventListener("pointerdown", () => { try { actx = actx || new AudioContext(); if (actx.state === "suspended") actx.resume(); } catch (e) {} });
function beep() {
  if (!lsFlag("sound", true) || !actx) return;
  try {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.14);
  } catch (e) {}
}


const peerOf = (c) => c.participants.find((u) => u !== me.uid);
const chatId = (a, b) => [a, b].sort().join("_");
const visibleChat = (c) => !!c.lastMessage && ms(c.lastMessageAt) > ms(c.deletedAt && c.deletedAt[me.uid]);
const nameOf = (uid) => (contacts[uid] && contacts[uid].name) || (people[uid] && (people[uid].name || people[uid].phone || people[uid].email)) || "Unknown";
const numberOf = (uid) => (people[uid] && (people[uid].phone || people[uid].email)) || "";

/* ---------- end-to-end encryption (ECDH P-256 + AES-GCM, Web Crypto) ----------
   Each device makes a key pair. The private key never leaves this browser (IndexedDB).
   The public key is saved in users/{uid}.publicKey. Message text is stored in Firestore
   only as "e2e:1:<iv>:<ciphertext>", so nobody reading the database can see it. */
const E2EE = false;   // encryption is switched OFF for now (set to true to turn it back on)
const te = new TextEncoder(), td = new TextDecoder();
const toB64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const idbOpen = () => new Promise((res, rej) => { const r = indexedDB.open("emaindi-keys", 1); r.onupgradeneeded = () => r.result.createObjectStore("k"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { const d = await idbOpen(); return new Promise((res, rej) => { const q = d.transaction("k").objectStore("k").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
const idbSet = async (k, v) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction("k", "readwrite"); t.objectStore("k").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

const ECDH = {name: "ECDH", namedCurve: "P-256"};
let myKeys = null, keysP = null;
const sharedKeys = {}, plainCache = new Map();

/* The private key is locked with a PIN you choose and a copy is saved in your PRIVATE area of Firestore
   (users/{uid}/private/keybackup). Firebase cannot read it. On a new phone or the APK you type the PIN once
   and the same key is restored, so every device can read your chats. */
const PBKDF_ITER = 310000;
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name: "PBKDF2", salt, iterations: PBKDF_ITER, hash: "SHA-256"}, base, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}
async function wrapPrivate(pair, pin) {
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv}, await pinKey(pin, salt), te.encode(JSON.stringify(jwk)));
  return {v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct)};
}
async function unwrapPrivate(b, pin) {
  const key = await pinKey(pin, fromB64(b.salt));
  const jwk = JSON.parse(td.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: fromB64(b.iv)}, key, fromB64(b.ct))));
  return crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveKey"]);
}
const pubOf = async (pair) => JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
const samePub = (a, b) => { try { const x = JSON.parse(a), y = JSON.parse(b); return x.x === y.x && x.y === y.y; } catch (e) { return false; } };

async function askNewPin() {
  for (;;) {
    const p1 = await dialog({title: "Create your chat PIN", text: "This PIN locks the key that opens your messages. You need it to read your chats on a new phone, in the app, or after reinstalling. If you forget it, old messages cannot be recovered. Use 8 or more characters.", input: "password", ok: "Next", cancel: ""});
    if (!p1 || p1.length < 8) { toast("The PIN must be at least 8 characters."); continue; }
    const p2 = await dialog({title: "Repeat your chat PIN", input: "password", ok: "Save PIN", cancel: "Back"});
    if (p2 === p1) return p1;
    if (p2 !== null) toast("The two PINs do not match.");
  }
}

let oldKeys = [], keyProblem = "";
async function initKeys() {
  if (!(window.crypto && crypto.subtle)) throw new Error("Encryption needs a secure (https) page");
  const uref = doc(db, "users", me.uid), bref = doc(db, "users", me.uid, "contacts", "_keybackup");
  oldKeys = (await idbGet("old:" + me.uid)) || [];
  const keepOld = async (p) => { if (p) { oldKeys = [...oldKeys, p]; await idbSet("old:" + me.uid, oldKeys); } };
  let local = await idbGet("pair:" + me.uid);
  const legacy = local; if (local && !local.privateKey.extractable) local = null;   // older key that cannot be backed up
  let udata = {}, backup = null, known = true, failCode = "";
  try {
    udata = (await getDoc(uref)).data() || {};
    const b = await getDoc(bref);
    if (b.exists()) backup = b.data();
    else { try { const o = await getDoc(doc(db, "users", me.uid, "private", "keybackup")); if (o.exists()) backup = o.data(); } catch (e) {} }
  } catch (e) { known = false; failCode = e.code || String(e); console.warn("Key backup check failed:", failCode); }

  if (!known) {                                   // offline or blocked: use whatever key this phone already has
    if (local || legacy) { myKeys = local || legacy; return; }
    throw new Error(failCode === "permission-denied" ? "Firestore rules block reading your key backup" : "Connect to the internet once to set up encryption");
  }
  if (local && backup && udata.publicKey && !samePub(await pubOf(local), udata.publicKey)) { await keepOld(local); local = null; }   // another device took over
  if (local && backup) {
    myKeys = local;
    if (!udata.publicKey) await setDoc(uref, {publicKey: await pubOf(local)}, {merge: true});
    return;
  }
  if (!local && legacy) await keepOld(legacy);    // keep the old key so older messages can still be opened
  if (!local && backup && udata.publicKey) {      // new phone / reinstall / APK: unlock with the PIN
    const pub = await crypto.subtle.importKey("jwk", JSON.parse(udata.publicKey), ECDH, true, []);
    for (;;) {
      const pin = await dialog({title: "Enter your chat PIN", text: "Needed once on this device to unlock your messages.", input: "password", ok: "Unlock", cancel: ""});
      if (!pin) continue;
      try {
        myKeys = {privateKey: await unwrapPrivate(backup, pin), publicKey: pub};
        await idbSet("pair:" + me.uid, myKeys);
        return;
      } catch (e) { toast("Wrong PIN. Try again."); }
    }
  }
  // first time (or an older key with no backup): make a key and lock a copy with a PIN
  const pair = local || await crypto.subtle.generateKey(ECDH, true, ["deriveKey"]);
  const pin = await askNewPin();
  try { await setDoc(bref, await wrapPrivate(pair, pin)); }
  catch (e) { throw new Error("Could not save the key backup (" + (e.code || e.message) + ")"); }
  const newPub = await pubOf(pair), prev = udata.publicKey;
  await setDoc(uref, prev && !samePub(prev, newPub) ? {publicKey: newPub, oldPublicKeys: arrayUnion(prev)} : {publicKey: newPub}, {merge: true});
  await idbSet("pair:" + me.uid, pair);
  myKeys = pair;
}

async function peerPublicKey(uid) {
  if (!(people[uid] && people[uid].publicKey)) {
    const s = await getDoc(doc(db, "users", uid));
    if (s.exists()) people[uid] = {...(people[uid] || {}), ...s.data()};
  }
  const pk = people[uid] && people[uid].publicKey;
  if (!pk) throw new Error("no-key");
  return pk;
}
async function sharedKey(uid) {
  await keysP;
  const pk = await peerPublicKey(uid);
  if (sharedKeys[uid] && sharedKeys[uid].pk === pk) return sharedKeys[uid].key;
  const pub = await crypto.subtle.importKey("jwk", JSON.parse(pk), ECDH, false, []);
  const key = await crypto.subtle.deriveKey({name: "ECDH", public: pub}, myKeys.privateKey, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  sharedKeys[uid] = {pk, key};
  return key;
}
async function encryptText(uid, text) {
  if (!E2EE) return text;
  const key = await sharedKey(uid), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, te.encode(text));
  return "e2e:1:" + toB64(iv) + ":" + toB64(ct);
}
async function tryDecrypt(priv, pubStr, iv, ct) {
  const pub = await crypto.subtle.importKey("jwk", JSON.parse(pubStr), ECDH, false, []);
  const key = await crypto.subtle.deriveKey({name: "ECDH", public: pub}, priv, {name: "AES-GCM", length: 256}, false, ["decrypt"]);
  return td.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv}, key, ct));
}
async function decryptText(uid, s) {
  if (typeof s !== "string" || !s.startsWith("e2e:")) return s || "";   // old unencrypted messages
  const ck = uid + s;
  if (plainCache.has(ck)) return plainCache.get(ck);
  const [, , ivs, cts] = s.split(":"), iv = fromB64(ivs), ct = fromB64(cts);
  let out = null;
  try { out = td.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv}, await sharedKey(uid), ct)); } catch (e) {}
  if (out === null && myKeys) {                 // try older keys (either side changed its key since)
    const p = people[uid] || {};
    const pubs = [p.publicKey, ...(p.oldPublicKeys || [])].filter(Boolean);
    const privs = [myKeys.privateKey, ...oldKeys.map((k) => k.privateKey)].filter(Boolean);
    for (const pv of privs) { for (const pb of pubs) { try { out = await tryDecrypt(pv, pb, iv, ct); break; } catch (e) {} } if (out !== null) break; }
  }
  if (out === null) return !E2EE ? "🔒 Encrypted message (encryption is switched off)" : myKeys ? "🔒 Message can't be decrypted on this device" : "🔒 Chat key not loaded" + (keyProblem ? " (" + keyProblem + ")" : "");
  plainCache.set(ck, out);
  return out;
}
const pvCache = new Map();
function preview(c) {
  const s = c.lastMessage || "";
  if (!s.startsWith("e2e:")) return s;
  const k = c.id + s;
  if (pvCache.has(k)) return pvCache.get(k);
  if (!myKeys) return "🔒";            // keys not ready yet (instant start): try again after they load
  pvCache.set(k, "🔒");
  decryptText(peerOf(c), s).then((t) => { pvCache.set(k, t); hooks.render(); });
  return "🔒";
}

function dayLabel(t) {
  const d = new Date(t), n = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === n.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {day: "numeric", month: "short", year: "numeric"});
}
function listTime(t) {
  if (!t) return "";
  const l = dayLabel(t);
  return l === "Today" ? hm(t) : l === "Yesterday" ? l : new Date(t).toLocaleDateString([], {day: "2-digit", month: "2-digit", year: "2-digit"});
}
function avatar(uid, cls = "") {
  const u = people[uid] || {}, n = nameOf(uid);
  let h = 0; for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const inner = u.photoUrl ? `<img src="${esc(u.photoUrl)}" alt="" referrerpolicy="no-referrer">` : esc((n[0] || "?").toUpperCase());
  return `<div class="av ${cls}" style="background:hsl(${h} 45% 42%)">${inner}${online(u) && !(me && uid === me.uid) ? '<i class="dot"></i>' : ""}</div>`;
}

/* ---------- watch other people's profiles ---------- */
let presOn = false;
export const pres = (on) => setDoc(doc(db, "users", me.uid), mySet().hideOnline ? {online: false} : {online: on, lastActive: serverTimestamp()}, {merge: true}).catch(() => {});
export function watch(uid) {
  if (watching[uid]) return;
  watching[uid] = onSnapshot(doc(db, "users", uid), (s) => {
    if (!s.exists()) return;
    const prevPk = people[uid] && people[uid].publicKey;
    people[uid] = s.data({serverTimestamps: "estimate"});
    if (prevPk !== people[uid].publicKey) { delete sharedKeys[uid]; pvCache.clear(); hooks.redecrypt(uid); }
    if (me && uid === me.uid) { hooks.meChanged(); if (!presOn) { presOn = true; pres(true); } }
    hooks.peerChanged(uid);
    hooks.render();
  });
}

/* ---------- chat lock (shared by both pages) ---------- */
const lockKey = (k) => k + ":" + me.uid;
export function lsGet(k, d) { try { const v = JSON.parse(localStorage.getItem(lockKey(k))); return v === null || v === undefined ? d : v; } catch (e) { return d; } }
export function lsSet(k, v) { try { localStorage.setItem(lockKey(k), JSON.stringify(v)); } catch (e) {} }
export const lockedIds = () => (me ? lsGet("locked", []) : []);
export const isLocked = (id) => lockedIds().includes(id);
// "unlocked" lasts a few minutes and is shared by both pages (so opening a locked chat from the folder doesn't ask twice)
export const isUnlocked = () => { try { return Date.now() - Number(sessionStorage.getItem("unlockedAt") || 0) < 5 * 60 * 1000; } catch (e) { return false; } };
export const markUnlocked = () => { try { sessionStorage.setItem("unlockedAt", String(Date.now())); } catch (e) {} };
export const relock = () => { try { sessionStorage.removeItem("unlockedAt"); } catch (e) {} };

async function pinHash(pin, salt) {
  if (window.crypto && crypto.subtle) {
    const base = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveBits"]);
    return toB64(await crypto.subtle.deriveBits({name: "PBKDF2", salt: fromB64(salt), iterations: 150000, hash: "SHA-256"}, base, 256));
  }
  let h = 5381; for (const ch of salt + pin) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;   // fallback if the page is not https
  return String(h);
}
async function newPinRecord() {
  for (;;) {
    const p1 = await dialog({title: "Create chat lock PIN", text: "Locked chats are hidden in a “Locked chats” folder and need this PIN to open. Use at least 4 characters. Forgot it? Log out and log in again to reset it.", input: "password", ok: "Next"});
    if (p1 === null) return null;
    if (p1.length < 4) { toast("Use at least 4 characters."); continue; }
    const p2 = await dialog({title: "Repeat the PIN", input: "password", ok: "Save"});
    if (p2 === null) return null;
    if (p2 !== p1) { toast("The two PINs do not match."); continue; }
    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    return {salt, hash: await pinHash(p1, salt)};
  }
}
export async function ensureLockPin() {
  if (lsGet("lockpin", null)) return true;
  const rec = await newPinRecord();
  if (!rec) return false;
  lsSet("lockpin", rec); return true;
}
let lockFails = 0;
export async function askUnlock(cover) {
  const rec = lsGet("lockpin", null);
  if (!rec) return true;
  const d = $("#dlg");
  try {
    for (;;) {
      if (cover) d.style.background = "#0b1220";          // hide the chat behind the PIN box
      const p = await dialog({title: "Enter chat lock PIN", text: "Forgot it? Log out and log in again to reset chat lock.", input: "password", ok: "Unlock"});
      if (p === null) return false;
      if ((await pinHash(p, rec.salt)) === rec.hash) { lockFails = 0; markUnlocked(); return true; }
      if (++lockFails >= 5) { lockFails = 0; toast("Too many wrong tries. Try again later."); return false; }
      toast("Wrong PIN.");
    }
  } finally { d.style.background = ""; }
}
export async function changeLockPin() {
  if (!(await askUnlock())) return;
  const rec = await newPinRecord();
  if (rec) { lsSet("lockpin", rec); toast("Lock PIN changed."); }
}
// returns "locked", "unlocked", or null if cancelled
export async function toggleLock(uid) {
  const id = chatId(me.uid, uid), set = lockedIds();
  if (set.includes(id)) {
    if (!isUnlocked() && !(await askUnlock())) return null;
    lsSet("locked", set.filter((x) => x !== id)); toast("Chat unlocked."); return "unlocked";
  }
  if (!(await ensureLockPin())) return null;
  lsSet("locked", [...set, id]);
  toast("Chat locked. Find it under “Locked chats” at the top of your chat list.");
  return "locked";
}
export async function deleteChat(uid) {
  const id = chatId(me.uid, uid);
  const ok = await dialog({title: "Delete this chat?", text: "It is removed from your list and your device only. The other person keeps their copy.", ok: "Delete", danger: true});
  if (!ok) return false;
  updateDoc(doc(db, "chats", id), {["deletedAt." + me.uid]: serverTimestamp(), ["unread." + me.uid]: 0}).catch((err) => { console.error(err); toast("Could not delete the chat."); });
  return true;
}

/* ---------- typing indicator (tracking what the other person is doing) ---------- */
export const typingUntil = {}, lastTyp = {};
export const isTyping = (c) => !!c && (typingUntil[c.id] || 0) > Date.now();
function trackTyping() {                // uses a local timer, so differing phone clocks don't matter
  let changed = false;
  for (const c of chats) {
    const v = ms(c.typing && c.typing[peerOf(c)]);
    if (v === 0) { if (typingUntil[c.id]) { typingUntil[c.id] = 0; changed = true; } lastTyp[c.id] = 0; continue; }
    if (v !== lastTyp[c.id]) {
      const first = lastTyp[c.id] === undefined;
      lastTyp[c.id] = v;
      if (!first) { typingUntil[c.id] = Date.now() + 4500; changed = true; setTimeout(() => hooks.render(), 4700); }
    }
  }
  return changed;
}

/* ---------- notifications + delivered ticks ---------- */
const seenAt = {}, delivering = new Set();
let notifyReady = false;
async function showNotif(c) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const o = peerOf(c);
  const locked = isLocked(c.id);
  let body = "New message";
  if (!locked) { try { body = (await decryptText(o, c.lastMessage)) || body; } catch (e) {} }
  const title = locked ? "emaindi" : nameOf(o), opts = {body, tag: c.id, renotify: true};
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification(title, opts); }
  catch (e) { try { new Notification(title, opts); } catch (_) {} }
}
function notifyNew() {
  for (const c of chats) {
    const t = ms(c.lastMessageAt), prev = seenAt[c.id] ?? (notifyReady ? 0 : t);
    seenAt[c.id] = t;
    if (t <= prev || !c.lastSender || c.lastSender === me.uid) continue;
    if (!(c.unread && c.unread[me.uid] > 0)) continue;
    beep();
    if (!document.hidden && hooks.viewing() === c.id) continue;
    showNotif(c);
  }
  notifyReady = true;
}
function markDelivered() {
  for (const c of chats) {
    const t = ms(c.lastMessageAt), key = c.id + t;
    if (c.lastSender && c.lastSender !== me.uid && t > ms(c.deliveredAt && c.deliveredAt[me.uid]) && !delivering.has(key)) {
      delivering.add(key);
      updateDoc(doc(db, "chats", c.id), {["deliveredAt." + me.uid]: serverTimestamp()}).catch(console.error);
    }
  }
}

/* ---------- pop-up sheets + phone back button ---------- */
export const MODALS = ["#info", "#sheet", "#perm", "#viewer"];
export function openModal(el) { if (el.hidden) history.pushState({modal: 1}, ""); el.hidden = false; }
export function closeModal(el) { if (el.hidden) return; el.hidden = true; if (history.state && history.state.modal) history.back(); }
const backFns = [];
export const onBack = (fn) => backFns.push(fn);
addEventListener("popstate", (e) => {
  const s = e.state || {};
  MODALS.forEach((id) => { const el = $(id); if (el) el.hidden = true; });
  backFns.forEach((f) => f(s));
});

/* ---------- contact info / my profile ---------- */
export function showInfo(uid) {
  const p = $("#info"), u = people[uid] || {}, mine = uid === me.uid;
  const hasChat = !mine && chats.some((c) => c.id === chatId(me.uid, uid) && visibleChat(c));
  p.innerHTML = `<div class="box">${avatar(uid, "big")}<h2>${esc(nameOf(uid))}</h2><div class="num">${esc(u.phone || u.email || "")}</div>
    ${u.bio ? `<div class="bio"><small>About</small>${esc(u.bio)}</div>` : ""}
    ${mine ? '<button class="btn" data-a="edit">Edit profile</button>' : `<button class="btn" data-a="name">${contacts[uid] ? "Edit contact name" : "Save to contacts"}</button>`}${hasChat ? '<button class="btn ghost danger" data-a="delchat">Delete chat</button>' : ""}${hasChat ? `<button class="btn ghost" data-a="lockchat">${isLocked(chatId(me.uid, uid)) ? "Unlock chat" : "Lock chat"}</button>` : ""}<button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "name") {
      const n = await dialog({title: "Contact name", input: "text", value: contacts[uid] ? contacts[uid].name : u.name || "", ok: "Save"});
      if (n && n.trim()) await setDoc(doc(db, "users", me.uid, "contacts", uid), {name: n.trim()});
      return showInfo(uid);
    }
    if (a === "delchat") { closeModal(p); await new Promise((r) => setTimeout(r, 250)); if (await deleteChat(uid)) hooks.chatDeleted(uid); return; }
    if (a === "lockchat") { closeModal(p); await new Promise((r) => setTimeout(r, 250)); const st = await toggleLock(uid); if (st) hooks.chatLockChanged(uid, st); return; }
    if (a === "edit") return (location.href = "settings.html");
    if (a === "x" || e.target === p) closeModal(p);
  };
}

/* ---------- instant start: recent chats are kept on this device (IndexedDB) ---------- */
const T = (n) => (n ? {toMillis: () => n} : null);
const packMs = (o) => { const r = {}; for (const k in o || {}) r[k] = ms(o[k]); return r; };
const unpackMs = (o) => { const r = {}; for (const k in o || {}) r[k] = T(o[k]); return r; };
let saveT = null, started = false;
export function saveCache() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!me || me.cached) return;
    const ids = new Set([me.uid, ...chats.map(peerOf)]), pp = {};
    ids.forEach((u) => { const p = people[u]; if (p) pp[u] = {uid: p.uid, name: p.name, phone: p.phone, email: p.email, photoUrl: p.photoUrl, bio: p.bio, settings: p.settings, publicKey: p.publicKey, oldPublicKeys: p.oldPublicKeys, lastActive: ms(p.lastActive)}; });
    const cs = chats.filter((c) => c.lastMessage).slice(0, 60).map((c) => ({id: c.id, participants: c.participants, lastMessage: c.lastMessage, lastMessageAt: ms(c.lastMessageAt), lastSender: c.lastSender || "", unread: c.unread || {}, lastRead: packMs(c.lastRead), deliveredAt: packMs(c.deliveredAt), deletedAt: packMs(c.deletedAt)}));
    idbSet("cache:" + me.uid, {chats: cs, people: pp, contacts: {...contacts}}).catch(() => {});
  }, 800);
}
export async function hydrate() {
  let uid = null; try { uid = localStorage.getItem("lastUid"); } catch (e) {}
  if (!uid) return;
  let d = null; try { d = await idbGet("cache:" + uid); } catch (e) {}
  if (!d || started) return;                       // real data already arrived
  me = {uid, cached: true};
  chats = (d.chats || []).map((c) => ({...c, lastMessageAt: T(c.lastMessageAt), lastRead: unpackMs(c.lastRead), deliveredAt: unpackMs(c.deliveredAt), deletedAt: unpackMs(c.deletedAt)}));
  for (const u in d.people || {}) people[u] = {...d.people[u], lastActive: T(d.people[u].lastActive)};
  Object.assign(contacts, d.contacts || {});
  hooks.meChanged(); hooks.render();
}

/* ---------- start-up (login check, presence, live data) ---------- */
export function startSession(onReady) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      // a saved login can take a moment to load: only go to login if there is still nobody after a short wait
      setTimeout(() => { if (!auth.currentUser) { try { localStorage.removeItem("lastUid"); } catch (e) {} location.replace("login.html"); } }, 2500);
      return;
    }
    if (started) return;
    started = true;
    me = user;
    try {
      if (!localStorage.getItem("lastUid")) { localStorage.removeItem("lockpin:" + user.uid); localStorage.removeItem("locked:" + user.uid); }   // new login resets chat lock
      localStorage.setItem("lastUid", user.uid);
    } catch (e) {}
    const loadKeys = () => {
      if (!E2EE) { keysP = Promise.resolve(); return; }
      keysP = initKeys().catch((e) => { keyProblem = e.message || String(e); console.error("Key setup failed:", e); toast("Encryption setup problem: " + keyProblem); });
      keysP.then(() => { if (myKeys) keyProblem = ""; plainCache.clear(); pvCache.clear(); hooks.render(); hooks.redecrypt(); });
    };
    loadKeys();
    addEventListener("online", () => { if (!myKeys) loadKeys(); });
    setDoc(doc(db, "users", me.uid), {uid: me.uid, email: (me.email || "").toLowerCase(), phone: me.phoneNumber || ""}, {merge: true}).catch(() => {});
    watch(me.uid);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    setInterval(() => { if (!document.hidden) pres(true); }, 25000);
    setInterval(() => hooks.render(), 20000);
    document.addEventListener("visibilitychange", () => pres(!document.hidden));
    addEventListener("pagehide", () => pres(false));

    onSnapshot(collection(db, "users", me.uid, "contacts"), (s) => {
      for (const k of Object.keys(contacts)) delete contacts[k];
      s.docs.forEach((d) => { if (d.id !== "_keybackup") contacts[d.id] = d.data(); });
      hooks.render();
    });
    onSnapshot(query(collection(db, "chats"), where("participants", "array-contains", me.uid)), (s) => {
      chats = s.docs.map((d) => ({id: d.id, ...d.data({serverTimestamps: "estimate"})}));
      chats.sort((a, b) => ms(b.lastMessageAt) - ms(a.lastMessageAt));
      chats.forEach((c) => watch(peerOf(c)));
      const tchg = trackTyping();
      notifyNew(); markDelivered();
      hooks.chatsChanged(tchg); hooks.render(); saveCache();
    }, console.error);
    onReady();
  });
}

/* ---------- keep the page fixed when the phone keyboard opens (like WhatsApp) ---------- */
export function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty("--app-h", (vv ? vv.height : innerHeight) + "px");
  window.scrollTo(0, 0);
  const box = $("#msgs"), t = $("#txt");
  if (box && t && document.activeElement === t) box.scrollTop = box.scrollHeight;
}
if (window.visualViewport) { visualViewport.addEventListener("resize", fitViewport); visualViewport.addEventListener("scroll", fitViewport); }
addEventListener("orientationchange", fitViewport);
fitViewport();

/* ---------- offline: app files cached by a service worker ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker:", e));

export {peerOf, chatId, visibleChat, nameOf, numberOf, avatar, dayLabel, listTime, mySet, preview, encryptText, decryptText, E2EE, idbGet, idbSet, beep, applyTheme, toB64, fromB64, te, td};
