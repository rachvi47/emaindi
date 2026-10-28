import {auth,db,onAuthStateChanged,doc,getDoc,setDoc,updateDoc,addDoc,collection,query,where,orderBy,onSnapshot,getDocs,serverTimestamp,increment,arrayUnion} from "./fire.js";

const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const hm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
const hidden = (u) => !!(u && u.settings && u.settings.hideOnline);
const online = (u) => !!(u && !hidden(u) && u.online && Date.now() - ms(u.lastActive) < 60000);
const lsFlag = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (e) { return d; } };
const mySet = () => (me && people[me.uid] && people[me.uid].settings) || {};

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
let presOn = false, notifyReady = false, snapSeq = 0, cur = null, msgs = [], msgUnsub = null, replyTo = null, searchTimer, delivering = new Set(), seenAt = {};

const peerOf = (c) => c.participants.find((u) => u !== me.uid);
const chatId = (a, b) => [a, b].sort().join("_");
const nameOf = (uid) => (contacts[uid] && contacts[uid].name) || (people[uid] && (people[uid].name || people[uid].phone || people[uid].email)) || "Unknown";
const numberOf = (uid) => (people[uid] && (people[uid].phone || people[uid].email)) || "";

/* ---------- end-to-end encryption (ECDH P-256 + AES-GCM, Web Crypto) ----------
   Each device makes a key pair. The private key never leaves this browser (IndexedDB).
   The public key is saved in users/{uid}.publicKey. Message text is stored in Firestore
   only as "e2e:1:<iv>:<ciphertext>", so nobody reading the database can see it. */
const te = new TextEncoder(), td = new TextDecoder();
const toB64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const idbOpen = () => new Promise((res, rej) => { const r = indexedDB.open("emaindi-keys", 1); r.onupgradeneeded = () => r.result.createObjectStore("k"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { const d = await idbOpen(); return new Promise((res, rej) => { const q = d.transaction("k").objectStore("k").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
const idbSet = async (k, v) => { const d = await idbOpen(); return new Promise((res, rej) => { const t = d.transaction("k", "readwrite"); t.objectStore("k").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

const ECDH = {name: "ECDH", namedCurve: "P-256"};
let myKeys = null, keysP = null;
const sharedKeys = {}, plainCache = new Map();

async function initKeys() {
  myKeys = await idbGet("pair:" + me.uid);
  let fresh = false;
  if (!myKeys) {
    myKeys = await crypto.subtle.generateKey(ECDH, false, ["deriveKey"]);
    await idbSet("pair:" + me.uid, myKeys);
    fresh = true;
  }
  const ref = doc(db, "users", me.uid);
  let has = false;
  try { has = !!(await getDoc(ref)).data()?.publicKey; } catch (e) {}
  if (fresh || !has) {
    const jwk = await crypto.subtle.exportKey("jwk", myKeys.publicKey);
    await setDoc(ref, {publicKey: JSON.stringify(jwk)}, {merge: true});
  }
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
  const key = await sharedKey(uid), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, te.encode(text));
  return "e2e:1:" + toB64(iv) + ":" + toB64(ct);
}
async function decryptText(uid, s) {
  if (typeof s !== "string" || !s.startsWith("e2e:")) return s || "";   // old unencrypted messages
  const ck = uid + s;
  if (plainCache.has(ck)) return plainCache.get(ck);
  let out;
  try {
    const [, , iv, ct] = s.split(":");
    out = td.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: fromB64(iv)}, await sharedKey(uid), fromB64(ct)));
    plainCache.set(ck, out);
  } catch (e) { out = "🔒 Message can't be decrypted on this device"; }
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
    people[uid] = s.data({serverTimestamps: "estimate"});
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
  const rows = chats.filter((c) => c.lastMessage).filter((c) => {
    const o = peerOf(c), p = people[o] || {};
    return !q || [nameOf(o), p.phone, p.email].join(" ").toLowerCase().includes(q);
  });
  let h = "";
  const fresh = found.filter((u) => u.uid !== me.uid);
  if (q && fresh.length) h += '<div class="sec">On emaindi</div>' + fresh.map((u) => `<button class="row" data-uid="${u.uid}">${avatar(u.uid)}<div class="meta"><div class="nm">${esc(nameOf(u.uid))}</div><div class="pv">${esc(u.phone || u.email)}</div></div></button>`).join("");
  if (rows.length) {
    if (q) h += '<div class="sec">Chats</div>';
    h += rows.map((c) => {
      const o = peerOf(c), n = (c.unread && c.unread[me.uid]) || 0, mine = c.lastSender === me.uid;
      const t = ms(c.lastMessageAt);
      return `<button class="row ${cur && cur.id === c.id ? "on" : ""}" data-uid="${o}">${avatar(o)}<div class="meta">
        <div class="line1"><span class="nm">${esc(nameOf(o))}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${esc(preview(c))}</span>${n ? `<span class="badge">${n}</span>` : ""}</div></div></button>`;
    }).join("");
  }
  $("#rows").innerHTML = h || `<div class="none">${q ? "No chats found. Enter the full phone number (with country code) or email to find someone." : "No chats yet. Search a phone number or email above to start one."}</div>`;
}
$("#rows").addEventListener("click", (e) => {
  const r = e.target.closest(".row");
  if (r) openChat(r.dataset.uid).catch((err) => { console.error("openChat failed:", err); alert("Could not open chat: " + (err.code || err.message)); });
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
async function openChat(uid) {
  if (uid === me.uid) return;
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
        alert("Could not open chat: " + (err.code || err.message) + "\nCheck your Firestore rules for the 'chats' collection.");
        return closeChat();
      }
    }
    if (!cur || cur.id !== id) return;
  }
  const peer = uid;
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("createdAt")), async (s) => {
    const raw = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({serverTimestamps: "estimate"})}))
      .filter((m) => !(m.deletedFor || []).includes(me.uid));          // "delete for me"
    const seq = ++snapSeq;
    const out = await Promise.all(raw.map(async (m) => ({
      ...m,
      text: await decryptText(peer, m.text),
      replyTo: m.replyTo ? {...m.replyTo, text: await decryptText(peer, m.replyTo.text)} : null,
    })));
    if (seq !== snapSeq || !cur || cur.id !== id) return;
    msgs = msgCache[id] = out;
    renderMsgs(); markRead();
  }, console.error);
  if (!/Mobi|Android/i.test(navigator.userAgent)) $("#txt").focus();
}
function doCloseChat() {
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
  const st = hidden(u) ? "" : online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
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
    alert(err.message === "no-key" ? "This person hasn't opened the updated app yet, so the message can't be encrypted. Ask them to open emaindi once, then try again." : "Could not encrypt the message.");
    return;
  }
  $("#txt").value = ""; grow(); clearReply();
  try {
    await addDoc(collection(db, "chats", id, "messages"), {senderId: me.uid, text: ct, createdAt: serverTimestamp(), replyTo: rep, deleted: false});
    await updateDoc(doc(db, "chats", id), {lastMessage: lastCt, lastMessageAt: serverTimestamp(), lastSender: me.uid, ["unread." + o]: increment(1)});
  } catch (err) { console.error(err); alert("Message could not be sent."); }
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
$("#txt").addEventListener("input", grow);
function grow() { const t = $("#txt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }

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
      updateDoc(ref, {deletedFor: arrayUnion(me.uid)}).catch((err) => { console.error(err); alert("Could not delete the message."); });
    }
    if (a === "delall") {
      try {
        await updateDoc(ref, {deleted: true, text: "", replyTo: null});
        if (msgs[msgs.length - 1].id === m.id) updateDoc(doc(db, "chats", cur.id), {lastMessage: "🚫 This message was deleted"});
      } catch (err) { console.error(err); alert("Could not delete the message."); }
    }
  };
});

/* ---------- contact info ---------- */
function showInfo(uid) {
  const p = $("#info"), u = people[uid] || {}, mine = uid === me.uid;
  p.innerHTML = `<div class="box">${avatar(uid, "big")}<h2>${esc(nameOf(uid))}</h2><div class="num">${esc(u.phone || u.email || "")}</div>
    ${u.bio ? `<div class="bio"><small>About</small>${esc(u.bio)}</div>` : ""}
    ${mine ? '<button class="btn" data-a="edit">Edit profile</button>' : `<button class="btn" data-a="name">${contacts[uid] ? "Edit contact name" : "Save to contacts"}</button>`}<button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "name") {
      const n = prompt("Contact name", contacts[uid] ? contacts[uid].name : u.name || "");
      if (n && n.trim()) await setDoc(doc(db, "users", me.uid, "contacts", uid), {name: n.trim()});
      return showInfo(uid);
    }
    if (a === "edit") return (location.href = "settings.html");
    if (a === "x" || e.target === p) closeModal(p);
  };
}

/* ---------- permissions: notifications + storage ---------- */
async function showPerm() {
  const p = $("#perm");
  const notif = "Notification" in window ? Notification.permission : "unsupported";
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const row = (icon, title, sub, state, act, label) => `<div class="pr"><span class="pi">${icon}</span><div class="tx"><b>${title}</b><small>${sub}</small></div>${
    state === "granted" ? '<span class="ok">✓ Allowed</span>' : state === "denied" ? '<span class="na">Blocked in browser settings</span>' : state === "unsupported" ? '<span class="na">Not supported</span>' : `<button class="go" data-a="${act}">${label}</button>`}</div>`;
  p.innerHTML = `<div class="box"><h2>Allow access</h2><p class="sub">Choose what emaindi can use. You can change this any time in your browser settings.</p>
    ${row("🔔", "Notifications", "Get alerted when a new message arrives.", notif, "notif", "Allow")}
    ${row("💾", "Storage", "Keep recent chats and app data saved on this device so it opens fast and works offline.", persisted === null ? "unsupported" : persisted ? "granted" : "default", "storage", "Allow")}
    <button class="btn" data-a="done" style="width:100%">Done</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "done" || e.target === p) { closeModal(p); localStorage.setItem("perm-seen", "1"); return; }
    if (a === "notif") { try { await Notification.requestPermission(); } catch (err) { console.error(err); } }
    if (a === "storage") { try { await navigator.storage.persist(); } catch (err) { console.error(err); } }
    if (a) showPerm();
  };
}

/* ---------- notifications for new messages ---------- */
async function showNotif(c) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const o = peerOf(c);
  let body = "New message";
  try { body = (await decryptText(o, c.lastMessage)) || body; } catch (e) {}
  const title = nameOf(o), opts = {body, tag: c.id, renotify: true};
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
    ids.forEach((u) => { const p = people[u]; if (p) pp[u] = {uid: p.uid, name: p.name, phone: p.phone, email: p.email, photoUrl: p.photoUrl, bio: p.bio, settings: p.settings, publicKey: p.publicKey, lastActive: ms(p.lastActive)}; });
    const cs = chats.filter((c) => c.lastMessage).slice(0, 60).map((c) => ({id: c.id, participants: c.participants, lastMessage: c.lastMessage, lastMessageAt: ms(c.lastMessageAt), lastSender: c.lastSender || "", unread: c.unread || {}, lastRead: packMs(c.lastRead), deliveredAt: packMs(c.deliveredAt)}));
    idbSet("cache:" + me.uid, {chats: cs, people: pp, contacts}).catch(() => {});
  }, 800);
}
async function hydrate() {
  let uid = null; try { uid = localStorage.getItem("lastUid"); } catch (e) {}
  if (!uid) return;
  let d = null; try { d = await idbGet("cache:" + uid); } catch (e) {}
  if (!d || started) return;                       // real data already arrived
  me = {uid, cached: true};
  chats = (d.chats || []).map((c) => ({...c, lastMessageAt: T(c.lastMessageAt), lastRead: unpackMs(c.lastRead), deliveredAt: unpackMs(c.deliveredAt)}));
  for (const u in d.people || {}) people[u] = {...d.people[u], lastActive: T(d.people[u].lastActive)};
  contacts = d.contacts || {};
  renderMe(); renderList();
}

/* ---------- start-up + online presence ---------- */
const pres = (on) => setDoc(doc(db, "users", me.uid), mySet().hideOnline ? {online: false} : {online: on, lastActive: serverTimestamp()}, {merge: true}).catch(() => {});

hydrate();
onAuthStateChanged(auth, (user) => {
  if (!user) { try { localStorage.removeItem("lastUid"); } catch (e) {} return location.replace("login.html"); }
  if (started) return;
  started = true;
  me = user;
  try { localStorage.setItem("lastUid", user.uid); } catch (e) {}
  keysP = initKeys().catch((e) => { console.error("Key setup failed:", e); alert("Could not set up encryption on this browser."); });
  keysP.then(() => { pvCache.clear(); renderList(); });
  setDoc(doc(db, "users", me.uid), {uid: me.uid, email: (me.email || "").toLowerCase(), phone: me.phoneNumber || ""}, {merge: true}).catch(() => {});
  watch(me.uid);
  if (!localStorage.getItem("perm-seen")) setTimeout(showPerm, 900);
  setInterval(() => { if (!document.hidden) pres(true); }, 25000);
  setInterval(() => { renderList(); cur && renderHead(); }, 20000);
  document.addEventListener("visibilitychange", () => { pres(!document.hidden); markRead(); });
  addEventListener("pagehide", () => pres(false));

  onSnapshot(collection(db, "users", me.uid, "contacts"), (s) => {
    contacts = {}; s.docs.forEach((d) => (contacts[d.id] = d.data()));
    renderList(); cur && (renderHead(), renderMsgs());
  });
  onSnapshot(query(collection(db, "chats"), where("participants", "array-contains", me.uid)), (s) => {
    chats = s.docs.map((d) => ({id: d.id, ...d.data({serverTimestamps: "estimate"})}));
    chats.sort((a, b) => ms(b.lastMessageAt) - ms(a.lastMessageAt));
    chats.forEach((c) => watch(peerOf(c)));
    if (cur) { cur = chats.find((c) => c.id === cur.id) || cur; renderMsgs(); markRead(); }
    notifyNew(); markDelivered(); renderList();
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
