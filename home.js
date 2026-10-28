import {auth,db,onAuthStateChanged,doc,getDoc,setDoc,updateDoc,addDoc,collection,query,where,orderBy,onSnapshot,getDocs,serverTimestamp,increment} from "./fire.js";

const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const hm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
const online = (u) => !!(u && u.online && Date.now() - ms(u.lastActive) < 60000);

let me, chats = [], people = {}, contacts = {}, watching = {}, found = [];
let friendUids = [], notifyReady = false, snapSeq = 0, cur = null, msgs = [], msgUnsub = null, replyTo = null, searchTimer, delivering = new Set(), seenAt = {};

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
  return `<div class="av ${cls}" style="background:hsl(${h} 45% 42%)">${inner}${online(u) ? '<i class="dot"></i>' : ""}</div>`;
}
function watch(uid) {
  if (watching[uid]) return;
  watching[uid] = onSnapshot(doc(db, "users", uid), (s) => {
    if (!s.exists()) return;
    people[uid] = s.data({serverTimestamps: "estimate"});
    renderList();
    if (cur && peerOf(cur) === uid) renderHead();
  });
}
function tick(m) {
  if (m.pending) return '<span class="tk">🕓</span>';
  const o = peerOf(cur), t = ms(m.createdAt);
  if (ms(cur.lastRead && cur.lastRead[o]) >= t) return '<span class="tk r">✓✓</span>';
  if (ms(cur.deliveredAt && cur.deliveredAt[o]) >= t) return '<span class="tk">✓✓</span>';
  return '<span class="tk">✓</span>';
}

/* ---------- chat list + search ---------- */
function renderList() {
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
  if (!q) {
    const fr = friendUids.filter((u) => u !== me.uid && people[u] && !chats.some((c) => c.lastMessage && peerOf(c) === u));
    if (fr.length) h += '<div class="sec">Contacts on emaindi</div>' + fr.map((u) => `<button class="row" data-uid="${u}">${avatar(u)}<div class="meta"><div class="nm">${esc(nameOf(u))}</div><div class="pv">${esc(numberOf(u))}</div></div></button>`).join("");
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
async function openChat(uid) {
  if (uid === me.uid) return;
  watch(uid);
  const id = chatId(me.uid, uid), ref = doc(db, "chats", id);
  // A missing chat doc can make getDoc throw "permission-denied" under common rules,
  // so treat an error the same as "does not exist" and create it instead.
  let exists = false;
  try { exists = (await getDoc(ref)).exists(); } catch (err) { console.warn("getDoc chat:", err.code || err); }
  if (!exists) {
    try {
      await setDoc(ref, {participants: [me.uid, uid].sort(), lastMessage: "", lastMessageAt: serverTimestamp(), lastSender: "", unread: {}, lastRead: {}, deliveredAt: {}}, {merge: true});
    } catch (err) {
      console.error("Could not create chat:", err);
      alert("Could not open chat: " + (err.code || err.message) + "\nCheck your Firestore rules for the 'chats' collection.");
      return;
    }
  }
  cur = chats.find((c) => c.id === id) || {id, participants: [me.uid, uid].sort(), unread: {}, lastRead: {}, deliveredAt: {}};
  msgs = []; clearReply();
  document.body.classList.add("chat-open");
  $("#empty").hidden = true; $("#conv").hidden = false;
  renderHead(); renderMsgs(true); renderList();
  msgUnsub && msgUnsub();
  const peer = uid;
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("createdAt")), async (s) => {
    const raw = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({serverTimestamps: "estimate"})}));
    const seq = ++snapSeq;
    const out = await Promise.all(raw.map(async (m) => ({
      ...m,
      text: await decryptText(peer, m.text),
      replyTo: m.replyTo ? {...m.replyTo, text: await decryptText(peer, m.replyTo.text)} : null,
    })));
    if (seq !== snapSeq || !cur || cur.id !== id) return;
    msgs = out;
    renderMsgs(); markRead();
  }, console.error);
  $("#txt").focus();
}
function closeChat() {
  msgUnsub && msgUnsub(); msgUnsub = null; cur = null;
  document.body.classList.remove("chat-open");
  $("#conv").hidden = true; $("#empty").hidden = false;
  renderList();
}
$("#back").addEventListener("click", closeChat);

function renderHead() {
  const o = peerOf(cur), u = people[o] || {};
  const st = online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
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
  if (e.key === "Enter" && !e.shiftKey && !/Mobi|Android/i.test(navigator.userAgent)) { e.preventDefault(); send(); }
});
$("#txt").addEventListener("input", grow);
function grow() { const t = $("#txt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }

/* ---------- message actions: reply, copy, delete ---------- */
function clearReply() { replyTo = null; $("#replybar").hidden = true; }
$("#replyx").addEventListener("click", clearReply);
$("#msgs").addEventListener("click", (e) => {
  const el = e.target.closest(".msg");
  const m = el && msgs.find((x) => x.id === el.dataset.id);
  if (!m || m.deleted || m.pending) return;
  const s = $("#sheet");
  s.innerHTML = `<div class="box"><button data-a="reply">Reply</button><button data-a="copy">Copy</button>${m.senderId === me.uid ? '<button data-a="del" class="danger">Delete for everyone</button>' : ""}<button data-a="x">Cancel</button></div>`;
  s.hidden = false;
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    s.hidden = true;
    if (a === "reply") { replyTo = m; $("#replytxt").textContent = m.text; $("#replybar").hidden = false; $("#txt").focus(); }
    if (a === "copy") navigator.clipboard && navigator.clipboard.writeText(m.text);
    if (a === "del") {
      await updateDoc(doc(db, "chats", cur.id, "messages", m.id), {deleted: true, text: ""});
      if (msgs[msgs.length - 1].id === m.id) updateDoc(doc(db, "chats", cur.id), {lastMessage: "🚫 This message was deleted"});
    }
  };
});

/* ---------- contact info ---------- */
function showInfo(uid) {
  const p = $("#info"), u = people[uid] || {};
  p.innerHTML = `<div class="box">${avatar(uid, "big")}<h2>${esc(nameOf(uid))}</h2><div class="num">${esc(u.phone || u.email || "")}</div>
    <button class="btn" data-a="name">${contacts[uid] ? "Edit contact name" : "Save to contacts"}</button><button class="btn ghost" data-a="x">Close</button></div>`;
  p.hidden = false;
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "name") {
      const n = prompt("Contact name", contacts[uid] ? contacts[uid].name : u.name || "");
      if (n && n.trim()) await setDoc(doc(db, "users", me.uid, "contacts", uid), {name: n.trim()});
      return showInfo(uid);
    }
    if (a === "x" || e.target === p) p.hidden = true;
  };
}

/* ---------- permissions: notifications, contacts, storage ---------- */
const hasContactApi = () => "contacts" in navigator && "ContactsManager" in window;
const friendKey = () => "friends:" + me.uid;
function loadFriends() { try { friendUids = JSON.parse(localStorage.getItem(friendKey()) || "[]"); } catch (e) { friendUids = []; } friendUids.forEach(watch); }

function normPhone(raw) {
  let d = String(raw).replace(/[\s\-().]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (d.startsWith("+")) return /^\+\d{8,15}$/.test(d) ? d : "";
  d = d.replace(/^0+/, "");
  const cc = localStorage.getItem("cc") || "";
  return cc && /^\d{6,14}$/.test(d) ? cc + d : "";
}
async function syncContacts() {
  if (!hasContactApi()) { alert("This browser can't open your contacts list. Use Chrome on Android, or search a phone number in the search bar."); return; }
  let picked;
  try { picked = await navigator.contacts.select(["name", "tel"], {multiple: true}); }
  catch (err) { console.error("Contacts:", err); return; }
  if (!picked.length) return;
  if (!localStorage.getItem("cc") && picked.some((p) => (p.tel || []).some((t) => !/^\s*(\+|00)/.test(t)))) {
    const cc = (prompt("Your country code, for example +91") || "").trim();
    if (/^\+\d{1,3}$/.test(cc)) localStorage.setItem("cc", cc);
  }
  const byNum = {};
  for (const p of picked) for (const t of p.tel || []) { const n = normPhone(t); if (n) byNum[n] = (p.name && p.name[0]) || ""; }
  const nums = Object.keys(byNum), hits = [];
  try {
    for (let i = 0; i < nums.length; i += 10) {
      const snap = await getDocs(query(collection(db, "users"), where("phone", "in", nums.slice(i, i + 10))));
      snap.docs.forEach((d) => hits.push(d.data()));
    }
  } catch (err) { console.error(err); alert("Could not check contacts: " + (err.code || err.message)); return; }
  for (const u of hits) {
    if (!u.uid || u.uid === me.uid) continue;
    people[u.uid] = u; watch(u.uid);
    if (!friendUids.includes(u.uid)) friendUids.push(u.uid);
    const nm = byNum[u.phone];
    if (nm && !contacts[u.uid]) setDoc(doc(db, "users", me.uid, "contacts", u.uid), {name: nm}).catch(() => {});
  }
  localStorage.setItem(friendKey(), JSON.stringify(friendUids));
  localStorage.setItem("contacts-synced", "1");
  renderList();
  alert(hits.length ? hits.length + " of your contacts are on emaindi." : "None of those contacts are on emaindi yet.");
}

async function showPerm() {
  const p = $("#perm");
  const notif = "Notification" in window ? Notification.permission : "unsupported";
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const row = (icon, title, sub, state, act, label) => `<div class="pr"><span class="pi">${icon}</span><div class="tx"><b>${title}</b><small>${sub}</small></div>${
    state === "granted" ? '<span class="ok">✓ Allowed</span>' : state === "denied" ? '<span class="na">Blocked in browser settings</span>' : state === "unsupported" ? '<span class="na">Not supported</span>' : `<button class="go" data-a="${act}">${label}</button>`}</div>`;
  p.innerHTML = `<div class="box"><h2>Allow access</h2><p class="sub">Choose what emaindi can use. You can change this any time in your browser settings.</p>
    ${row("🔔", "Notifications", "Get alerted when a new message arrives.", notif, "notif", "Allow")}
    ${row("👥", "Contacts", "Find friends who are on emaindi. Your contacts are only checked, never uploaded.", hasContactApi() ? "default" : "unsupported", "contacts", localStorage.getItem("contacts-synced") ? "Choose again" : "Choose")}
    ${row("💾", "Storage", "Keep recent chats and app data saved on this device so it opens fast and works offline.", persisted === null ? "unsupported" : persisted ? "granted" : "default", "storage", "Allow")}
    <button class="btn" data-a="done" style="width:100%">Done</button></div>`;
  p.hidden = false;
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "done" || e.target === p) { p.hidden = true; localStorage.setItem("perm-seen", "1"); return; }
    if (a === "notif") { try { await Notification.requestPermission(); } catch (err) { console.error(err); } }
    if (a === "storage") { try { await navigator.storage.persist(); } catch (err) { console.error(err); } }
    if (a === "contacts") { p.hidden = true; await syncContacts(); }
    if (a) showPerm();
  };
}
$("#permBtn").addEventListener("click", showPerm);

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
    if (!document.hidden && cur && cur.id === c.id) continue;
    showNotif(c);
  }
  notifyReady = true;
}

/* ---------- offline: app files cached by a service worker ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker:", e));

/* ---------- start-up + online presence ---------- */
const pres = (on) => setDoc(doc(db, "users", me.uid), {online: on, lastActive: serverTimestamp()}, {merge: true}).catch(() => {});

onAuthStateChanged(auth, (user) => {
  if (!user) return location.replace("login.html");
  if (me) return;
  me = user;
  keysP = initKeys().catch((e) => { console.error("Key setup failed:", e); alert("Could not set up encryption on this browser."); });
  setDoc(doc(db, "users", me.uid), {uid: me.uid, email: (me.email || "").toLowerCase(), phone: me.phoneNumber || ""}, {merge: true}).catch(() => {});
  pres(true);
  loadFriends();
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
