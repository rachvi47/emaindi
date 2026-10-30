import {auth,db,onAuthStateChanged,doc,getDoc,setDoc,updateDoc,addDoc,collection,query,where,orderBy,onSnapshot,getDocs,serverTimestamp,increment,arrayUnion,limit} from "./fire.js";

const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const hm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
const hidden = (u) => !!(u && u.settings && u.settings.hideOnline);
const online = (u) => !!(u && !hidden(u) && u.online && Date.now() - ms(u.lastActive) < 60000);
const lsFlag = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (e) { return d; } };
const mySet = () => (me && people[me.uid] && people[me.uid].settings) || {};

/* ---------- small UI helpers (alert/prompt can be blocked inside an app WebView) ---------- */
let toastT;
function toast(t) {
  const m = $("#toast"); if (!m) return;
  m.textContent = t; m.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (m.hidden = true), 3200);
}
function dialog({title, text = "", input = "", value = "", ok = "OK", cancel = "Cancel", danger = false}) {
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

let me, chats = [], people = {}, contacts = {}, watching = {}, found = [];
let lockView = false, lockOpen = false, presOn = false, notifyReady = false, snapSeq = 0, cur = null, msgs = [], msgUnsub = null, replyTo = null, searchTimer, delivering = new Set(), seenAt = {};

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
  decryptText(peerOf(c), s).then((t) => { pvCache.set(k, t); renderList(); });
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
function renderMe() { $("#meBtn").innerHTML = avatar(me.uid); }
function watch(uid) {
  if (watching[uid]) return;
  watching[uid] = onSnapshot(doc(db, "users", uid), (s) => {
    if (!s.exists()) return;
    const prevPk = people[uid] && people[uid].publicKey;
    people[uid] = s.data({serverTimestamps: "estimate"});
    if (prevPk !== people[uid].publicKey) { delete sharedKeys[uid]; pvCache.clear(); redecrypt(uid); }
    if (me && uid === me.uid) { renderMe(); if (!presOn) { presOn = true; pres(true); } }
    renderList();
    if (cur && peerOf(cur) === uid) renderHead();
  });
}
function tick(m) {
  if (m.pending) return '<span class="tk">🕓</span>';
  const o = peerOf(cur), t = ms(m.createdAt);
  const noRx = mySet().noReceipts || (people[o] && people[o].settings && people[o].settings.noReceipts);
  if (!noRx && ms(cur.lastRead && cur.lastRead[o]) >= t) return '<span class="tk r">✓✓</span>';
  if (ms(cur.deliveredAt && cur.deliveredAt[o]) >= t) return '<span class="tk">✓✓</span>';
  return '<span class="tk">✓</span>';
}

/* ---------- chat list + search ---------- */
function renderList() {
  if (typeof saveCache === "function") saveCache();
  const q = $("#q").value.trim().toLowerCase();
  const lockedSet = new Set(lockedIds());
  const rows = chats.filter(visibleChat).filter((c) => (lockView ? lockedSet.has(c.id) : !lockedSet.has(c.id))).filter((c) => {
    const o = peerOf(c), p = people[o] || {};
    return !q || [nameOf(o), p.phone, p.email].join(" ").toLowerCase().includes(q);
  });
  let h = "";
  if (lockView) h += lockHeaderRows();
  else if (!q) { const n = chats.filter((c) => visibleChat(c) && lockedSet.has(c.id)).length; if (n) h += lockFolderRow(n); }
  if (lockView && !rows.length) h += '<div class="none">No locked chats yet. Long-press a chat and choose “Lock chat”.</div>';
  const fresh = found.filter((u) => u.uid !== me.uid);
  if (q && fresh.length) h += '<div class="sec">On emaindi</div>' + fresh.map((u) => `<button class="row" data-uid="${u.uid}">${avatar(u.uid)}<div class="meta"><div class="nm">${esc(nameOf(u.uid))}</div><div class="pv">${esc(u.phone || u.email)}</div></div></button>`).join("");
  if (rows.length) {
    if (q) h += '<div class="sec">Chats</div>';
    h += rows.map((c) => {
      const o = peerOf(c), n = (c.unread && c.unread[me.uid]) || 0, mine = c.lastSender === me.uid;
      const t = ms(c.lastMessageAt);
      return `<button class="row ${cur && cur.id === c.id ? "on" : ""}" data-chat="1" data-uid="${o}">${avatar(o)}<div class="meta">
        <div class="line1"><span class="nm">${esc(nameOf(o))}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${isTyping(c) ? '<span class="typ">typing…</span>' : esc(preview(c))}</span>${n ? `<span class="badge">${n}</span>` : ""}</div></div></button>`;
    }).join("");
  }
  $("#rows").innerHTML = h || `<div class="none">${q ? "No chats found. Enter the full phone number (with country code) or email to find someone." : "No chats yet. Search a phone number or email above to start one."}</div>`;
}
$("#rows").addEventListener("click", (e) => {
  if (lpFired) { lpFired = false; return; }
  const lk = e.target.closest("[data-lk]");
  if (lk) return lockAction(lk.dataset.lk);
  const r = e.target.closest(".row");
  if (r) openChat(r.dataset.uid).catch((err) => { console.error("openChat failed:", err); toast("Could not open chat: " + (err.code || err.message)); });
});
$("#q").addEventListener("input", () => {
  renderList();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(findUsers, 350);
});
async function findUsers() {
  const raw = $("#q").value.trim();
  found = [];
  const email = raw.includes("@") && raw.length > 4;
  const digits = raw.replace(/[\s\-().]/g, "");
  const phone = /^\+?\d{6,15}$/.test(digits);
  if (!email && !phone) return renderList();
  try {
    const qy = email
      ? query(collection(db, "users"), where("email", "==", raw.toLowerCase()))
      : query(collection(db, "users"), where("phone", "in", [digits, "+" + digits.replace(/^\+/, "")]));
    const snap = await getDocs(qy);
    if ($("#q").value.trim() !== raw) return;
    found = snap.docs.map((d) => d.data());
    found.forEach((u) => { people[u.uid] = u; watch(u.uid); });
  } catch (err) { console.error("Search failed:", err); }
  renderList();
}

/* ---------- open a chat ---------- */
const msgCache = {};   // decrypted messages kept in memory, so re-opening a chat is instant
const rawCache = {};   // messages as stored (encrypted), kept so they can be decrypted again if a key arrives late
async function decodeAndShow(id, peer) {
  const raw = rawCache[id] || [], seq = ++snapSeq;
  const out = await Promise.all(raw.map(async (m) => ({
    ...m,
    text: await decryptText(peer, m.text),
    replyTo: m.replyTo ? {...m.replyTo, text: await decryptText(peer, m.replyTo.text)} : null,
  })));
  if (seq !== snapSeq || !cur || cur.id !== id) return;
  msgs = msgCache[id] = out;
  renderMsgs(); markRead();
}
function redecrypt(uid) { if (cur && (!uid || peerOf(cur) === uid)) decodeAndShow(cur.id, peerOf(cur)); }
async function openChat(uid) {
  if (uid === me.uid) return;
  if (isLocked(chatId(me.uid, uid)) && !lockOpen && !(await askUnlock())) return;
  watch(uid);
  const id = chatId(me.uid, uid), ref = doc(db, "chats", id), known = chats.some((c) => c.id === id);
  cur = chats.find((c) => c.id === id) || {id, participants: [me.uid, uid].sort(), unread: {}, lastRead: {}, deliveredAt: {}};
  msgs = msgCache[id] || []; clearReply();
  // open the screen straight away (no waiting for the network)
  if (history.state && history.state.chat) history.replaceState({chat: id}, ""); else history.pushState({chat: id}, "");
  document.body.classList.add("chat-open");
  $("#empty").hidden = true; $("#conv").hidden = false;
  renderHead(); renderMsgs(true); renderList();
  msgUnsub && msgUnsub(); msgUnsub = null;
  if (!known) {
    // brand-new chat: create it first (a missing doc can make getDoc throw permission-denied)
    let exists = false;
    try { exists = (await getDoc(ref)).exists(); } catch (err) { console.warn("getDoc chat:", err.code || err); }
    if (!exists) {
      try {
        await setDoc(ref, {participants: [me.uid, uid].sort(), lastMessage: "", lastMessageAt: serverTimestamp(), lastSender: "", unread: {}, lastRead: {}, deliveredAt: {}}, {merge: true});
      } catch (err) {
        console.error("Could not create chat:", err);
        toast("Could not open chat: " + (err.code || err.message) + "\nCheck your Firestore rules for the 'chats' collection.");
        return closeChat();
      }
    }
    if (!cur || cur.id !== id) return;
  }
  const peer = uid;
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("createdAt")), (s) => {
    rawCache[id] = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({serverTimestamps: "estimate"})}))
      .filter((m) => !(m.deletedFor || []).includes(me.uid))          // "delete for me"
      .filter((m) => ms(m.createdAt) > ms(cur && cur.deletedAt && cur.deletedAt[me.uid]));   // after "delete chat"
    decodeAndShow(id, peer);
  }, console.error);
  if (!/Mobi|Android/i.test(navigator.userAgent)) $("#txt").focus();
}
function doCloseChat() {
  stopTyping();
  msgUnsub && msgUnsub(); msgUnsub = null; cur = null;
  document.body.classList.remove("chat-open");
  $("#conv").hidden = true; $("#empty").hidden = false;
  renderList();
}
function closeChat() {
  if (history.state && history.state.chat) history.back(); else doCloseChat();   // popstate finishes the job
}
$("#back").addEventListener("click", closeChat);

function renderHead() {
  const o = peerOf(cur), u = people[o] || {};
  const st = isTyping(cur) ? '<span class="typing-txt">typing<span class="tdots"><i></i><i></i><i></i></span></span>' : hidden(u) ? "" : online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
  $("#peer").innerHTML = `${avatar(o, "sm")}<div style="min-width:0"><div class="nm">${esc(nameOf(o))}</div><small>${st}</small></div>`;
}
$("#peer").addEventListener("click", () => cur && showInfo(peerOf(cur)));

function renderMsgs(force) {
  if (!cur) return;
  const box = $("#msgs"), stick = force || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let h = "", last = "";
  for (const m of msgs) {
    const t = ms(m.createdAt), d = dayLabel(t), mine = m.senderId === me.uid;
    if (d !== last) { h += `<div class="day">${d}</div>`; last = d; }
    const q = m.replyTo ? `<div class="quote"><b>${esc(m.replyTo.name)}</b>${esc(m.replyTo.text)}</div>` : "";
    h += `<div class="msg ${mine ? "me" : ""} ${m.deleted ? "del" : ""}" data-id="${m.id}">${m.deleted ? "" : q}<div class="t">${m.deleted ? "🚫 This message was deleted" : esc(m.text)}</div><div class="ft">${hm(t)} ${mine ? tick(m) : ""}</div></div>`;
  }
  if (isTyping(cur)) h += '<div class="msg typing"><i></i><i></i><i></i></div>';
  box.innerHTML = h;
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------- send, read receipts ---------- */
async function send() {
  const t = $("#txt").value.trim();
  if (!t || !cur) return;
  const id = cur.id, o = peerOf(cur);
  let ct, lastCt, rep = null;
  try {
    ct = await encryptText(o, t);
    lastCt = await encryptText(o, t.slice(0, 200));
    if (replyTo) rep = {text: await encryptText(o, replyTo.text.slice(0, 100)), name: replyTo.senderId === me.uid ? "You" : nameOf(replyTo.senderId)};
  } catch (err) {
    console.error(err);
    toast(err.message === "no-key" ? "This person hasn't opened the updated app yet, so the message can't be encrypted. Ask them to open emaindi once, then try again." : "Could not encrypt the message.");
    return;
  }
  $("#txt").value = ""; grow(); clearReply(); stopTyping();
  const fail = (err) => { console.error(err); toast("Message could not be sent."); };
  // not awaited on purpose: offline, these wait in the phone's queue and go out when the internet returns
  addDoc(collection(db, "chats", id, "messages"), {senderId: me.uid, text: ct, createdAt: serverTimestamp(), replyTo: rep, deleted: false}).catch(fail);
  updateDoc(doc(db, "chats", id), {lastMessage: lastCt, lastMessageAt: serverTimestamp(), lastSender: me.uid, ["unread." + o]: increment(1)}).catch(fail);
}
function markRead() {
  if (!cur || document.hidden) return;
  const last = msgs[msgs.length - 1];
  const need = (cur.unread && cur.unread[me.uid] > 0) || (last && last.senderId !== me.uid && !last.pending && ms(last.createdAt) > ms(cur.lastRead && cur.lastRead[me.uid]));
  if (mySet().noReceipts) {
    if (cur.unread && cur.unread[me.uid] > 0) updateDoc(doc(db, "chats", cur.id), {["unread." + me.uid]: 0}).catch(console.error);
    return;
  }
  if (need) updateDoc(doc(db, "chats", cur.id), {["lastRead." + me.uid]: serverTimestamp(), ["unread." + me.uid]: 0}).catch(console.error);
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
$("#send").addEventListener("click", send);
$("#txt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && lsFlag("enterSend", true)) { e.preventDefault(); send(); }
});
/* ---------- typing indicator ---------- */
let typingOn = false, typingSentAt = 0;
const typingUntil = {}, lastTyp = {};
const isTyping = (c) => !!c && (typingUntil[c.id] || 0) > Date.now();
function sendTyping(on) {
  if (!cur || !me) return;
  if (on) { if (Date.now() - typingSentAt < 2500) return; typingSentAt = Date.now(); typingOn = true; }
  else { if (!typingOn) return; typingOn = false; typingSentAt = 0; }
  updateDoc(doc(db, "chats", cur.id), {["typing." + me.uid]: on ? serverTimestamp() : 0}).catch(() => {});
}
const stopTyping = () => sendTyping(false);
function refreshTyping() { renderList(); if (cur) { renderHead(); renderMsgs(); } }
function trackTyping() {                // uses a local timer, so differing phone clocks don't matter
  let changed = false;
  for (const c of chats) {
    const v = ms(c.typing && c.typing[peerOf(c)]);
    if (v === 0) { if (typingUntil[c.id]) { typingUntil[c.id] = 0; changed = true; } lastTyp[c.id] = 0; continue; }
    if (v !== lastTyp[c.id]) {
      const first = lastTyp[c.id] === undefined;
      lastTyp[c.id] = v;
      if (!first) { typingUntil[c.id] = Date.now() + 4500; changed = true; setTimeout(refreshTyping, 4700); }
    }
  }
  return changed;
}
$("#txt").addEventListener("input", () => { grow(); $("#txt").value.trim() ? sendTyping(true) : stopTyping(); });
$("#txt").addEventListener("blur", stopTyping);

function grow() { const t = $("#txt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }

/* ---------- chat lock: hide chats behind a PIN, like WhatsApp ---------- */
const lockKey = (k) => k + ":" + me.uid;
function lsGet(k, d) { try { const v = JSON.parse(localStorage.getItem(lockKey(k))); return v === null || v === undefined ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(lockKey(k), JSON.stringify(v)); } catch (e) {} }
function lockedIds() { return me ? lsGet("locked", []) : []; }
function isLocked(id) { return lockedIds().includes(id); }
function lockRow(act, icon, title, sub) { return `<button class="row" data-lk="${act}"><div class="av" style="background:#14213D;color:#fff">${icon}</div><div class="meta"><div class="nm">${title}</div><div class="pv">${sub}</div></div></button>`; }
function lockFolderRow(n) { return lockRow("open", "🔒", "Locked chats", n + (n === 1 ? " chat" : " chats")); }
function lockHeaderRows() { return lockRow("back", "←", "Locked chats", "Tap to go back") + lockRow("pin", "🔑", "Change lock PIN", ""); }

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
async function ensureLockPin() {
  if (lsGet("lockpin", null)) return true;
  const rec = await newPinRecord();
  if (!rec) return false;
  lsSet("lockpin", rec); return true;
}
let lockFails = 0, needRelock = false;
async function askUnlock(cover) {
  const rec = lsGet("lockpin", null);
  if (!rec) return true;
  const d = $("#dlg");
  try {
    for (;;) {
      if (cover) d.style.background = "#0b1220";          // hide the chat behind the PIN box
      const p = await dialog({title: "Enter chat lock PIN", text: "Forgot it? Log out and log in again to reset chat lock.", input: "password", ok: "Unlock"});
      if (p === null) return false;
      if ((await pinHash(p, rec.salt)) === rec.hash) { lockFails = 0; lockOpen = true; return true; }
      if (++lockFails >= 5) { lockFails = 0; toast("Too many wrong tries. Try again later."); return false; }
      toast("Wrong PIN.");
    }
  } finally { d.style.background = ""; }
}
async function changeLockPin() {
  if (!(await askUnlock())) return;
  const rec = await newPinRecord();
  if (rec) { lsSet("lockpin", rec); toast("Lock PIN changed."); }
}
function leaveLockView() {
  if (!lockView) return;
  if (history.state && history.state.lock) history.back();
  else { lockView = false; lockOpen = false; renderList(); }
}
async function lockAction(a) {
  if (a === "open") {
    if (!lockOpen && !(await askUnlock())) return;
    history.pushState({lock: 1}, ""); lockView = true; lockOpen = true; renderList();
  }
  if (a === "back") leaveLockView();
  if (a === "pin") await changeLockPin();
}
async function toggleLock(uid) {
  const id = chatId(me.uid, uid), set = lockedIds();
  if (set.includes(id)) {
    if (!lockOpen && !(await askUnlock())) return;
    lsSet("locked", set.filter((x) => x !== id)); toast("Chat unlocked.");
  } else {
    if (!(await ensureLockPin())) return;
    lsSet("locked", [...set, id]);
    if (cur && cur.id === id) closeChat();
    toast("Chat locked. Find it under “Locked chats” at the top of your list.");
  }
  renderList();
}
// ask for the PIN again when you come back to the app while a locked chat / the folder was open
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { needRelock = lockView || (cur && isLocked(cur.id)); lockOpen = false; return; }
  if (!needRelock) return;
  needRelock = false;
  if (await askUnlock(true)) return;
  if (cur && isLocked(cur.id)) closeChat();
  setTimeout(leaveLockView, 300);
});

/* ---------- delete a chat from the recent list (long-press / right-click), like WhatsApp ---------- */
let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
const rowsEl = $("#rows");
rowsEl.addEventListener("pointerdown", (e) => {
  const r = e.target.closest(".row[data-chat]"); if (!r) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => { lpFired = true; chatMenu(r.dataset.uid); }, 550);
});
["pointerup", "pointercancel", "pointerleave"].forEach((t) => rowsEl.addEventListener(t, () => clearTimeout(lpTimer)));
rowsEl.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8) clearTimeout(lpTimer); });
rowsEl.addEventListener("contextmenu", (e) => { const r = e.target.closest(".row[data-chat]"); if (r) { e.preventDefault(); chatMenu(r.dataset.uid); } });

function chatMenu(uid) {
  const s = $("#sheet");
  if (!s.hidden) return;
  s.innerHTML = `<div class="box"><button data-a="lock">${isLocked(chatId(me.uid, uid)) ? "Unlock chat" : "Lock chat"}</button><button data-a="del" class="danger">Delete chat</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === "lock") setTimeout(() => toggleLock(uid), 250);
    if (a === "del") setTimeout(() => deleteChat(uid), 250);
  };
}
async function deleteChat(uid) {
  const id = chatId(me.uid, uid);
  const ok = await dialog({title: "Delete this chat?", text: "It is removed from your list and your device only. The other person keeps their copy.", ok: "Delete", danger: true});
  if (!ok) return;
  if (cur && cur.id === id) closeChat();
  delete msgCache[id];
  updateDoc(doc(db, "chats", id), {["deletedAt." + me.uid]: serverTimestamp(), ["unread." + me.uid]: 0}).catch((err) => { console.error(err); toast("Could not delete the chat."); });
}

/* ---------- offline: banner + keep the latest messages of recent chats on the phone ---------- */
const prefetched = new Set();
function prefetchRecent() {
  if (!navigator.onLine || (me && me.cached)) return;
  chats.filter(visibleChat).slice(0, 8).forEach((c) => {
    const k = c.id + ms(c.lastMessageAt);
    if (prefetched.has(k)) return;
    prefetched.add(k);
    getDocs(query(collection(db, "chats", c.id, "messages"), orderBy("createdAt", "desc"), limit(40))).catch(() => {});
  });
}
function netBanner() { const b = $("#offline"); if (b) b.hidden = navigator.onLine; }
addEventListener("online", () => { netBanner(); prefetchRecent(); });
addEventListener("offline", netBanner);
netBanner();

/* ---------- message actions: reply, copy, delete ---------- */
function clearReply() { replyTo = null; $("#replybar").hidden = true; }
$("#replyx").addEventListener("click", clearReply);
$("#msgs").addEventListener("click", (e) => {
  const el = e.target.closest(".msg");
  const m = el && msgs.find((x) => x.id === el.dataset.id);
  if (!m || m.pending) return;
  const mine = m.senderId === me.uid;
  const s = $("#sheet");
  s.innerHTML = `<div class="box">${m.deleted ? "" : '<button data-a="reply">Reply</button><button data-a="copy">Copy</button>'}<button data-a="delme" class="danger">Delete for me</button>${mine && !m.deleted ? '<button data-a="delall" class="danger">Delete for everyone</button>' : ""}<button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    const ref = doc(db, "chats", cur.id, "messages", m.id);
    if (a === "reply") { replyTo = m; $("#replytxt").textContent = m.text; $("#replybar").hidden = false; $("#txt").focus(); }
    if (a === "copy") navigator.clipboard && navigator.clipboard.writeText(m.text);
    if (a === "delme") {
      msgs = msgs.filter((x) => x.id !== m.id); msgCache[cur.id] = msgs; renderMsgs();   // gone at once
      updateDoc(ref, {deletedFor: arrayUnion(me.uid)}).catch((err) => { console.error(err); toast("Could not delete the message."); });
    }
    if (a === "delall") {
      try {
        await updateDoc(ref, {deleted: true, text: "", replyTo: null});
        if (msgs[msgs.length - 1].id === m.id) updateDoc(doc(db, "chats", cur.id), {lastMessage: "🚫 This message was deleted"});
      } catch (err) { console.error(err); toast("Could not delete the message."); }
    }
  };
});

/* ---------- contact info ---------- */
function showInfo(uid) {
  const p = $("#info"), u = people[uid] || {}, mine = uid === me.uid;
  p.innerHTML = `<div class="box">${avatar(uid, "big")}<h2>${esc(nameOf(uid))}</h2><div class="num">${esc(u.phone || u.email || "")}</div>
    ${u.bio ? `<div class="bio"><small>About</small>${esc(u.bio)}</div>` : ""}
    ${mine ? '<button class="btn" data-a="edit">Edit profile</button>' : `<button class="btn" data-a="name">${contacts[uid] ? "Edit contact name" : "Save to contacts"}</button>`}${!mine && chats.some((c) => c.id === chatId(me.uid, uid) && visibleChat(c)) ? '<button class="btn ghost danger" data-a="delchat">Delete chat</button>' : ""}${!mine && chats.some((c) => c.id === chatId(me.uid, uid) && visibleChat(c)) ? `<button class="btn ghost" data-a="lockchat">${isLocked(chatId(me.uid, uid)) ? "Unlock chat" : "Lock chat"}</button>` : ""}<button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "name") {
      const n = await dialog({title: "Contact name", input: "text", value: contacts[uid] ? contacts[uid].name : u.name || "", ok: "Save"});
      if (n && n.trim()) await setDoc(doc(db, "users", me.uid, "contacts", uid), {name: n.trim()});
      return showInfo(uid);
    }
    if (a === "delchat") { closeModal(p); await new Promise((r) => setTimeout(r, 250)); return deleteChat(uid); }
    if (a === "lockchat") { closeModal(p); await new Promise((r) => setTimeout(r, 250)); return toggleLock(uid); }
    if (a === "edit") return (location.href = "settings.html");
    if (a === "x" || e.target === p) closeModal(p);
  };
}

/* ---------- permissions: notifications + storage ---------- */
async function allowAll() {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) {}
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  // Median.co / GoNative app wrapper: ask Android for push permission (only if the app has it switched on)
  try { const m = window.median || window.gonative; if (m && m.onesignal && m.onesignal.register) m.onesignal.register(); } catch (e) {}
}
async function showPerm() {
  const p = $("#perm");
  const notif = "Notification" in window ? Notification.permission : "unsupported";
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const row = (icon, title, sub, state) => `<div class="pr"><span class="pi">${icon}</span><div class="tx"><b>${title}</b><small>${sub}</small></div>${
    state === "granted" ? '<span class="ok">✓ Allowed</span>' : state === "denied" ? '<span class="na">Blocked in settings</span>' : state === "unsupported" ? '<span class="na">Not supported here</span>' : '<span class="na">Not allowed yet</span>'}</div>`;
  p.innerHTML = `<div class="box"><h2>Allow access</h2><p class="sub">One tap to let emaindi alert you about new messages and keep your recent chats saved on this phone. Chats are stored in the app's own private storage, so Android does not need a separate storage permission.</p>
    ${row("🔔", "Notifications", "Get alerted when a new message arrives.", notif)}
    ${row("💾", "Saved chats", "Keeps recent chats on this device so the app opens fast and works offline.", persisted === null ? "unsupported" : persisted ? "granted" : "default")}
    <button class="btn" data-a="all" style="width:100%">Allow all</button><button class="btn ghost" data-a="done" style="width:100%">Not now</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "done" || e.target === p) { closeModal(p); localStorage.setItem("perm-seen", "1"); return; }
    if (a === "all") { await allowAll(); localStorage.setItem("perm-seen", "1"); showPerm(); }
  };
}

/* ---------- notifications for new messages ---------- */
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
    if (!document.hidden && cur && cur.id === c.id) continue;
    showNotif(c);
  }
  notifyReady = true;
}

/* ---------- offline: app files cached by a service worker ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker:", e));


/* ---------- back button / swipe-back: chat -> chat list, never straight out of the app ---------- */
const MODALS = ["#info", "#sheet", "#perm"];
function openModal(el) { if (el.hidden) history.pushState({modal: 1}, ""); el.hidden = false; }
function closeModal(el) { if (el.hidden) return; el.hidden = true; if (history.state && history.state.modal) history.back(); }
history.replaceState({list: 1}, "");
addEventListener("popstate", (e) => {
  const s = e.state || {};
  MODALS.forEach((id) => ($(id).hidden = true));
  if (!s.chat && cur) doCloseChat();
  if (!s.lock && !s.chat && lockView) { lockView = false; lockOpen = false; renderList(); }
});


/* ---------- instant start: recent chats are kept on this device (IndexedDB) ---------- */
const T = (n) => (n ? {toMillis: () => n} : null);
const packMs = (o) => { const r = {}; for (const k in o || {}) r[k] = ms(o[k]); return r; };
const unpackMs = (o) => { const r = {}; for (const k in o || {}) r[k] = T(o[k]); return r; };
let saveT = null, started = false;
function saveCache() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!me || me.cached) return;
    const ids = new Set([me.uid, ...chats.map(peerOf)]), pp = {};
    ids.forEach((u) => { const p = people[u]; if (p) pp[u] = {uid: p.uid, name: p.name, phone: p.phone, email: p.email, photoUrl: p.photoUrl, bio: p.bio, settings: p.settings, publicKey: p.publicKey, oldPublicKeys: p.oldPublicKeys, lastActive: ms(p.lastActive)}; });
    const cs = chats.filter((c) => c.lastMessage).slice(0, 60).map((c) => ({id: c.id, participants: c.participants, lastMessage: c.lastMessage, lastMessageAt: ms(c.lastMessageAt), lastSender: c.lastSender || "", unread: c.unread || {}, lastRead: packMs(c.lastRead), deliveredAt: packMs(c.deliveredAt), deletedAt: packMs(c.deletedAt)}));
    idbSet("cache:" + me.uid, {chats: cs, people: pp, contacts}).catch(() => {});
  }, 800);
}
async function hydrate() {
  let uid = null; try { uid = localStorage.getItem("lastUid"); } catch (e) {}
  if (!uid) return;
  let d = null; try { d = await idbGet("cache:" + uid); } catch (e) {}
  if (!d || started) return;                       // real data already arrived
  me = {uid, cached: true};
  chats = (d.chats || []).map((c) => ({...c, lastMessageAt: T(c.lastMessageAt), lastRead: unpackMs(c.lastRead), deliveredAt: unpackMs(c.deliveredAt), deletedAt: unpackMs(c.deletedAt)}));
  for (const u in d.people || {}) people[u] = {...d.people[u], lastActive: T(d.people[u].lastActive)};
  contacts = d.contacts || {};
  renderMe(); renderList();
}

/* ---------- start-up + online presence ---------- */
const pres = (on) => setDoc(doc(db, "users", me.uid), mySet().hideOnline ? {online: false} : {online: on, lastActive: serverTimestamp()}, {merge: true}).catch(() => {});

hydrate();
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
    keysP.then(() => { if (myKeys) keyProblem = ""; plainCache.clear(); pvCache.clear(); renderList(); redecrypt(); });
  };
  loadKeys();
  addEventListener("online", () => { if (!myKeys) loadKeys(); });
  setDoc(doc(db, "users", me.uid), {uid: me.uid, email: (me.email || "").toLowerCase(), phone: me.phoneNumber || ""}, {merge: true}).catch(() => {});
  watch(me.uid);
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  if (!localStorage.getItem("perm-seen")) setTimeout(showPerm, 900);
  setInterval(() => { if (!document.hidden) pres(true); }, 25000);
  setInterval(() => { renderList(); cur && renderHead(); }, 20000);
  document.addEventListener("visibilitychange", () => { pres(!document.hidden); if (document.hidden) stopTyping(); markRead(); });
  addEventListener("pagehide", () => pres(false));

  onSnapshot(collection(db, "users", me.uid, "contacts"), (s) => {
    contacts = {}; s.docs.forEach((d) => { if (d.id !== "_keybackup") contacts[d.id] = d.data(); });
    renderList(); cur && (renderHead(), renderMsgs());
  });
  onSnapshot(query(collection(db, "chats"), where("participants", "array-contains", me.uid)), (s) => {
    chats = s.docs.map((d) => ({id: d.id, ...d.data({serverTimestamps: "estimate"})}));
    chats.sort((a, b) => ms(b.lastMessageAt) - ms(a.lastMessageAt));
    chats.forEach((c) => watch(peerOf(c)));
    const tchg = trackTyping();
    if (cur) { cur = chats.find((c) => c.id === cur.id) || cur; renderMsgs(); markRead(); if (tchg) renderHead(); }
    notifyNew(); markDelivered(); renderList(); prefetchRecent();
  }, console.error);
});

/* ---------- keep header fixed when the phone keyboard opens (like WhatsApp) ---------- */
function fitViewport() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty("--app-h", (vv ? vv.height : innerHeight) + "px");
  window.scrollTo(0, 0);
  const box = $("#msgs");
  if (cur && box && document.activeElement === $("#txt")) box.scrollTop = box.scrollHeight;
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitViewport);
  visualViewport.addEventListener("scroll", fitViewport);
}
addEventListener("orientationchange", fitViewport);
$("#txt").addEventListener("focus", () => setTimeout(fitViewport, 300));
fitViewport();
