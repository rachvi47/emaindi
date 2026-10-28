import {auth,db,onAuthStateChanged,doc,getDoc,setDoc,updateDoc,addDoc,collection,query,where,orderBy,onSnapshot,getDocs,serverTimestamp,increment} from "./fire.js";

const $ = (s) => document.querySelector(s);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);
const hm = (t) => new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
const online = (u) => !!(u && u.online && Date.now() - ms(u.lastActive) < 60000);

let me, chats = [], people = {}, contacts = {}, watching = {}, found = [];
let cur = null, msgs = [], msgUnsub = null, replyTo = null, searchTimer, delivering = new Set();

const peerOf = (c) => c.participants.find((u) => u !== me.uid);
const chatId = (a, b) => [a, b].sort().join("_");
const nameOf = (uid) => (contacts[uid] && contacts[uid].name) || (people[uid] && (people[uid].name || people[uid].phone || people[uid].email)) || "Unknown";
const numberOf = (uid) => (people[uid] && (people[uid].phone || people[uid].email)) || "";

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
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${esc(c.lastMessage)}</span>${n ? `<span class="badge">${n}</span>` : ""}</div></div></button>`;
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
  msgUnsub = onSnapshot(query(collection(db, "chats", id, "messages"), orderBy("createdAt")), (s) => {
    msgs = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({serverTimestamps: "estimate"})}));
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
  const rep = replyTo ? {text: replyTo.text.slice(0, 100), name: replyTo.senderId === me.uid ? "You" : nameOf(replyTo.senderId)} : null;
  $("#txt").value = ""; grow(); clearReply();
  try {
    await addDoc(collection(db, "chats", id, "messages"), {senderId: me.uid, text: t, createdAt: serverTimestamp(), replyTo: rep, deleted: false});
    await updateDoc(doc(db, "chats", id), {lastMessage: t.slice(0, 200), lastMessageAt: serverTimestamp(), lastSender: me.uid, ["unread." + o]: increment(1)});
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

/* ---------- start-up + online presence ---------- */
const pres = (on) => setDoc(doc(db, "users", me.uid), {online: on, lastActive: serverTimestamp()}, {merge: true}).catch(() => {});

onAuthStateChanged(auth, (user) => {
  if (!user) return location.replace("login.html");
  if (me) return;
  me = user;
  setDoc(doc(db, "users", me.uid), {uid: me.uid, email: (me.email || "").toLowerCase(), phone: me.phoneNumber || ""}, {merge: true}).catch(() => {});
  pres(true);
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
    markDelivered(); renderList();
  }, console.error);
});
