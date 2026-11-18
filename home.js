// home.js - the chat list page. Opening a chat goes to chat.html.
import {db, doc, getDocs, setDoc, updateDoc, query, collection, where, orderBy, limit, serverTimestamp} from "./fire.js";
import {$, esc, ms, me, chats, people, hooks, watch, peerOf, chatId, visibleChat, nameOf, avatar, listTime, preview, isTyping,
  lockedIds, isLocked, isUnlocked, relock, askUnlock, changeLockPin, toggleLock, deleteChat, openModal, closeModal, onBack,
  showInfo, startSession, saveCache, dialog, toast, fitViewport, groupAvatar, pickPeople, toggleLockById, mySet, isBlocked, toggleBlock, contacts} from "./common.js";
import {initCalls} from "./call.js";
// push.js is loaded only when needed, so the app still works even if that file is missing or broken
const initPush = (uid) => import("./push.js").then((m) => m.initPush(uid)).catch((e) => console.warn("Push:", e));

let found = [], searchTimer = null, lockView = false, needRelock = false;

// NEW: in a chat with yourself there is no "other" person, so fall back to your own uid
const peer = (c) => peerOf(c) || me.uid;

// NEW: pinned chats (saved on this device, separate for each account)
const pinKey = () => "pins-" + (me ? me.uid : "");
function pinnedIds() { try { return JSON.parse(localStorage.getItem(pinKey()) || "[]"); } catch (e) { return []; } }
const isPinned = (id) => pinnedIds().includes(id);
function togglePin(id) {
  const a = pinnedIds(), i = a.indexOf(id);
  if (i >= 0) a.splice(i, 1); else a.unshift(id);
  try { localStorage.setItem(pinKey(), JSON.stringify(a)); } catch (e) {}
}

/* ---------- chat list + search ---------- */
function renderMe() { const b = $("#meBtn"); if (b && me) b.innerHTML = avatar(me.uid); }
hooks.meChanged = renderMe;

function lockRow(act, icon, title, sub) { return `<button class="row" data-lk="${act}"><div class="av" style="background:#14213D;color:#fff">${icon}</div><div class="meta"><div class="nm">${title}</div><div class="pv">${sub}</div></div></button>`; }
const lockFolderRow = (n) => lockRow("open", "🔒", "Locked chats", n + (n === 1 ? " chat" : " chats"));
const lockHeaderRows = () => lockRow("back", "←", "Locked chats", "Tap to go back") + lockRow("pin", "🔑", "Change lock PIN", "");

function renderList() {
  if (!me) return;
  const q = $("#q").value.trim().toLowerCase();
  const lockedSet = new Set(lockedIds());
  const rows = chats.filter(visibleChat).filter((c) => (lockView ? lockedSet.has(c.id) : !lockedSet.has(c.id))).filter((c) => {
    if (c.isGroup) return !q || (c.name || "").toLowerCase().includes(q);   // GROUP: search by group name
    const o = peer(c), p = people[o] || {};
    return !q || [nameOf(o), p.phone, p.email].join(" ").toLowerCase().includes(q);
  });
  const pins = pinnedIds();
  rows.sort((a, b) => (pins.includes(b.id) ? 1 : 0) - (pins.includes(a.id) ? 1 : 0));   // NEW: pinned chats stay on top
  let h = "";
  if (lockView) h += lockHeaderRows();
  else if (!q) { const n = chats.filter((c) => visibleChat(c) && lockedSet.has(c.id)).length; if (n) h += lockFolderRow(n); }
  if (lockView && !rows.length) h += '<div class="none">No locked chats yet. Long-press a chat and choose “Lock chat”.</div>';
  const fresh = found;   // CHANGED: your own account is now included in search results too
  // SUGGESTIONS: people you know (saved contacts, earlier chats incl. deleted ones, group members) that match what you typed
  let sugg = [];
  if (q && !lockView) {
    const have = new Set([me.uid, ...fresh.map((u) => u.uid), ...rows.filter((c) => !c.isGroup).map(peer)]);
    const pool = new Set(Object.keys(contacts));
    chats.forEach((c) => (c.participants || []).forEach((u) => pool.add(u)));
    const hay = (u) => [nameOf(u), (people[u] || {}).phone, (people[u] || {}).email].join(" ").toLowerCase();
    sugg = [...pool].filter((u) => !have.has(u) && (people[u] || contacts[u]) && hay(u).includes(q))
      .sort((a, b) => (nameOf(b).toLowerCase().startsWith(q) ? 1 : 0) - (nameOf(a).toLowerCase().startsWith(q) ? 1 : 0) || nameOf(a).localeCompare(nameOf(b))).slice(0, 8);
  }
  if (q && fresh.length) h += '<div class="sec">On emaindi</div>' + fresh.map((u) => `<button class="row" data-uid="${u.uid}">${avatar(u.uid)}<div class="meta"><div class="nm">${esc(nameOf(u.uid))}</div><div class="pv">${esc(u.phone || u.email)}</div></div></button>`).join("");
  if (rows.length) {
    if (q) h += '<div class="sec">Chats</div>';
    h += rows.map((c) => {
      if (c.isGroup) {   // GROUP row
        const n = (c.unread && c.unread[me.uid]) || 0, t = ms(c.lastMessageAt), pinned = pins.includes(c.id);
        const who = c.lastSender ? (c.lastSender === me.uid ? "You" : nameOf(c.lastSender)) + ": " : "";
        return `<button class="row" data-chat="1" data-gid="${esc(c.id)}">${groupAvatar(c.id, c.name, "", c.photo)}<div class="meta">
        <div class="line1"><span class="nm">${esc(c.name || "Group")}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${esc(who + preview(c))}</span>${(n || pinned) ? `<span style="display:flex;align-items:center;gap:6px">${pinned ? '<span style="font-size:12px">📌</span>' : ""}${n ? `<span class="badge">${n}</span>` : ""}</span>` : ""}</div></div></button>`;
      }
      const o = peer(c), self = o === me.uid;
      const n = self ? 0 : (c.unread && c.unread[me.uid]) || 0, mine = !self && c.lastSender === me.uid;   // self chat: no unread badge, no tick
      const t = ms(c.lastMessageAt), pinned = pins.includes(c.id);
      return `<button class="row" data-chat="1" data-uid="${o}">${avatar(o)}<div class="meta">
        <div class="line1"><span class="nm">${esc(nameOf(o))}${self ? " (You)" : ""}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${isTyping(c) ? '<span class="typ">typing…</span>' : isBlocked(o) ? "🚫 Blocked" : esc(preview(c))}</span>${(n || pinned) ? `<span style="display:flex;align-items:center;gap:6px">${pinned ? '<span style="font-size:12px">📌</span>' : ""}${n ? `<span class="badge">${n}</span>` : ""}</span>` : ""}</div></div></button>`;
    }).join("");
  }
  if (sugg.length) h += '<div class="sec">Suggestions</div>' + sugg.map((u) => `<button class="row" data-uid="${esc(u)}">${avatar(u)}<div class="meta"><div class="nm">${esc(nameOf(u))}</div><div class="pv">${esc((people[u] || {}).phone || (people[u] || {}).email || "")}</div></div></button>`).join("");
  $("#rows").innerHTML = h || `<div class="none">${q ? "No chats found. Enter the full phone number (with country code) or email to find someone." : "No chats yet. Search a phone number or email above to start one."}</div>`;
}
hooks.render = renderList;

async function openGroup(gid) {   // GROUP
  if (isLocked(gid) && !isUnlocked() && !(await askUnlock())) return;
  location.href = "chat.html?g=" + encodeURIComponent(gid);
}
async function openChat(uid) {
  if (isLocked(chatId(me.uid, uid)) && !isUnlocked() && !(await askUnlock())) return;
  location.href = "chat.html?u=" + encodeURIComponent(uid);
}

let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
const rowsEl = $("#rows");
rowsEl.addEventListener("click", (e) => {
  if (lpFired) { lpFired = false; return; }
  const lk = e.target.closest("[data-lk]");
  if (lk) return lockAction(lk.dataset.lk);
  const r = e.target.closest(".row");
  if (r) (r.dataset.gid ? openGroup(r.dataset.gid) : openChat(r.dataset.uid)).catch((err) => { console.error(err); toast("Could not open chat: " + (err.code || err.message)); });
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
  if (!navigator.onLine) { toast("You're offline. Searching for new people needs internet."); return renderList(); }
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

/* ---------- locked-chats folder ---------- */
function leaveLockView() {
  if (!lockView) return;
  if (history.state && history.state.lock) history.back();
  else { lockView = false; relock(); renderList(); }
}
async function lockAction(a) {
  if (a === "open") {
    if (!isUnlocked() && !(await askUnlock())) return;
    history.pushState({lock: 1}, ""); lockView = true; renderList();
  }
  if (a === "back") leaveLockView();
  if (a === "pin") await changeLockPin();
}
onBack((s) => { if (!s.lock && lockView) { lockView = false; relock(); renderList(); } });
// ask for the PIN again when you come back while the locked folder was open
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { needRelock = lockView; return; }
  if (!needRelock) return;
  needRelock = false; relock();
  if (await askUnlock(true)) return;
  leaveLockView();
});

/* ---------- long-press a chat: lock / delete ---------- */
rowsEl.addEventListener("pointerdown", (e) => {
  const r = e.target.closest(".row[data-chat]"); if (!r) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => { lpFired = true; chatMenu(r.dataset.uid, r.dataset.gid); }, 550);
});
["pointerup", "pointercancel", "pointerleave"].forEach((t) => rowsEl.addEventListener(t, () => clearTimeout(lpTimer)));
rowsEl.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8) clearTimeout(lpTimer); });
rowsEl.addEventListener("contextmenu", (e) => { const r = e.target.closest(".row[data-chat]"); if (r) { e.preventDefault(); chatMenu(r.dataset.uid, r.dataset.gid); } });
function chatMenu(uid, gid) {
  const s = $("#sheet");
  if (!s.hidden) return;
  const cid = gid || chatId(me.uid, uid), self = !gid && uid === me.uid;
  const chat = chats.find((c) => c.id === cid);
  const title = gid ? (chat && chat.name) || "Group" : nameOf(uid) + (self ? " (You)" : "");
  const blocked = !gid && !self && isBlocked(uid);
  s.innerHTML = `<div class="box">
    <div style="padding:12px 16px 8px;text-align:center;font-weight:700;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
    <button data-a="pin">${isPinned(cid) ? "📌 Unpin chat" : "📌 Pin chat"}</button>
    <button data-a="lock">${isLocked(cid) ? "🔓 Unlock chat" : "🔒 Lock chat"}</button>
    ${gid || self ? "" : `<button data-a="block">${blocked ? "✅ Unblock" : "🚫 Block chat"}</button>`}
    ${gid ? "" : '<button data-a="del" class="danger">🗑️ Delete chat</button>'}
    <button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === "pin") { togglePin(cid); renderList(); }
    if (a === "lock") setTimeout(async () => { await toggleLockById(cid); renderList(); }, 250);
    if (a === "block") setTimeout(() => toggleBlock(uid), 250);
    if (a === "del") setTimeout(async () => { await deleteChat(uid); renderList(); }, 250);
  };
}

/* ---------- top-right menu: Read all / Settings ---------- */
function unreadChats() {
  const locked = new Set(lockedIds());   // locked chats stay untouched
  return chats.filter((c) => visibleChat(c) && !locked.has(c.id) && c.unread && c.unread[me.uid] > 0);
}
function readAll() {
  const todo = unreadChats();
  if (!todo.length) return toast("No unread messages.");
  const quiet = !!mySet().noReceipts;   // with read receipts off, others don't get blue ticks
  todo.forEach((c) => updateDoc(doc(db, "chats", c.id), quiet ? {["unread." + me.uid]: 0} : {["unread." + me.uid]: 0, ["lastRead." + me.uid]: serverTimestamp()}).catch(console.error));
  toast(todo.length === 1 ? "1 chat marked as read." : todo.length + " chats marked as read.");
}
function homeMenu() {
  const s = $("#sheet");
  if (!s.hidden || !me) return;
  const n = unreadChats().length;
  s.innerHTML = `<div class="box"><button data-a="read">✓✓ Read all${n ? " (" + n + ")" : ""}</button><button data-a="set">⚙️ Settings</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === "read") readAll();
    if (a === "set") setTimeout(() => (location.href = "settings.html"), 200);
  };
}

/* ---------- GROUPS: create a new group ---------- */
async function newGroup() {
  if (!me) return;
  const r = await pickPeople({title: "New group", ok: "Create", nameField: true});
  if (!r) return;
  if (r.ids.length > 99) return toast("A group can have up to 100 people.");
  try {
    const ref = doc(collection(db, "chats"));
    await setDoc(ref, {isGroup: true, name: r.name.slice(0, 60), participants: [me.uid, ...r.ids], admins: [me.uid], createdBy: me.uid,
      createdAt: serverTimestamp(), lastMessage: "Group created", lastMessageAt: serverTimestamp(), lastSender: me.uid, unread: {}});
    location.href = "chat.html?g=" + encodeURIComponent(ref.id);
  } catch (err) { console.error(err); toast("Could not create the group: " + (err.code || err.message)); }
}

/* ---------- NEW: my QR code + QR scanner ---------- */
// The QR code only holds "emaindi:<uid>". The scanner reads the uid, then loads that account from Firestore.
const QR_PREFIX = "emaindi:";
let scanner = null;

// tap my photo -> show my QR code
function showMyQr() {
  if (!me) return;
  if (!window.QRCode) return toast("QR code could not load. Check your internet and try again.");
  const p = $("#qr");
  if (!p.hidden) return;
  p.innerHTML = `<div class="box" style="text-align:center">
    <h2>My QR code</h2>
    <p class="sub">Ask a friend to scan this with the scanner on their emaindi home screen.</p>
    <div id="qrcode"></div>
    <b>${esc(nameOf(me.uid))}</b>
    <button class="btn ghost" data-a="prof" style="width:100%;margin-top:12px">View my profile</button>
    <button class="btn" data-a="done" style="width:100%">Close</button></div>`;
  openModal(p);
  new QRCode($("#qrcode"), {text: QR_PREFIX + me.uid, width: 220, height: 220, colorDark: "#14213D", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M});
  p.onclick = (e) => {
    const a = e.target.dataset.a;
    if (!a && e.target !== p) return;
    closeModal(p);
    if (a === "prof") setTimeout(() => showInfo(me.uid), 250);   // the old "tap photo" behaviour is still available here
  };
}

// stop the camera (safe to call many times)
async function stopScanner() {
  if (!scanner) return;
  const s = scanner; scanner = null;
  try { await s.stop(); } catch (e) {}
  try { s.clear(); } catch (e) {}
}
function closeScan() { stopScanner(); closeModal($("#scan")); }
// also stop the camera if the popup is closed any other way (e.g. phone back button)
new MutationObserver(() => { if ($("#scan").hidden) stopScanner(); }).observe($("#scan"), {attributes: true, attributeFilter: ["hidden"]});

// scanner button -> open camera
function openScan() {
  if (!me) return;
  if (!window.Html5Qrcode) return toast("Scanner could not load. Check your internet and try again.");
  if (!navigator.onLine) return toast("You're offline. Scanning needs internet.");
  const p = $("#scan");
  if (!p.hidden) return;
  p.innerHTML = `<div class="box" style="text-align:center">
    <h2>Scan QR code</h2>
    <p class="sub">Point the camera at a friend's emaindi QR code.</p>
    <div id="scanview"></div>
    <button class="btn ghost" data-a="done" style="width:100%;margin-top:12px">Cancel</button></div>`;
  openModal(p);
  p.onclick = (e) => { if (e.target.dataset.a === "done" || e.target === p) closeScan(); };
  let handled = false;
  scanner = new Html5Qrcode("scanview");
  scanner.start({facingMode: "environment"}, {fps: 10, qrbox: {width: 220, height: 220}},
    (text) => { if (handled) return; handled = true; onScanned(text); },
    () => {}
  ).catch((err) => {
    console.error("Camera failed:", err);
    toast("Could not open the camera. Please allow camera access.");
    closeScan();
  });
}

// a code was read -> find that account
async function onScanned(text) {
  await stopScanner();
  const t = String(text || "").trim();
  if (!t.startsWith(QR_PREFIX)) { toast("This is not an emaindi QR code."); return closeScan(); }
  const uid = t.slice(QR_PREFIX.length).trim();
  if (!uid) { toast("This is not an emaindi QR code."); return closeScan(); }
  if (uid === me.uid) { toast("That's your own QR code."); return closeScan(); }
  try {
    const snap = await getDocs(query(collection(db, "users"), where("uid", "==", uid), limit(1)));
    if (snap.empty) { toast("Account not found."); return closeScan(); }
    const u = snap.docs[0].data();
    people[u.uid] = u; watch(u.uid);
    showScanned(u);
  } catch (err) {
    console.error("Scan lookup failed:", err);
    toast("Could not load that account: " + (err.code || err.message));
    closeScan();
  }
}

// show the scanned account
function showScanned(u) {
  const p = $("#scan");
  p.innerHTML = `<div class="box" style="text-align:center">
    <h2>Account found</h2>
    <div style="display:flex;justify-content:center;margin:12px 0">${avatar(u.uid)}</div>
    <b>${esc(nameOf(u.uid))}</b>
    <p class="sub">${esc(u.phone || u.email || "")}</p>
    <button class="btn" data-a="chat" style="width:100%">Message</button>
    <button class="btn ghost" data-a="done" style="width:100%">Close</button></div>`;
  p.onclick = (e) => {
    const a = e.target.dataset.a;
    if (!a && e.target !== p) return;
    closeScan();
    if (a === "chat") setTimeout(() => openChat(u.uid).catch((err) => { console.error(err); toast("Could not open chat: " + (err.code || err.message)); }), 250);
  };
}

/* ---------- offline: banner + keep the latest messages of recent chats on the phone ---------- */
const prefetched = new Set();
function prefetchRecent() {
  if (!navigator.onLine || !me || me.cached) return;
  chats.filter(visibleChat).slice(0, 8).forEach((c) => {
    const k = c.id + ms(c.lastMessageAt);
    if (prefetched.has(k)) return;
    prefetched.add(k);
    getDocs(query(collection(db, "chats", c.id, "messages"), orderBy("createdAt", "desc"), limit(40))).catch(() => {});
  });
}
hooks.chatsChanged = prefetchRecent;
// NEW: save the chat list on the phone right before the page is closed, reloaded or hidden (common.js already saves on every change)
const saveNow = () => { try { saveCache(true); } catch (e) {} };
addEventListener("pagehide", saveNow);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
function netBanner() { const b = $("#offline"); if (b) b.hidden = navigator.onLine; }
addEventListener("online", () => { netBanner(); prefetchRecent(); });
addEventListener("offline", netBanner);
netBanner();

/* ---------- permissions: notifications + storage ---------- */
async function allowAll() {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) {}
  try { if (me) await initPush(me.uid); } catch (e) {}   // NEW: register this phone for notifications when the app is closed
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  try { if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) { const st = await navigator.mediaDevices.getUserMedia({audio: true}); st.getTracks().forEach((t) => t.stop()); } } catch (e) {}   // microphone, for voice messages and calls
  // Median.co / GoNative app wrapper: ask Android for push permission (only if the app has it switched on)
  try { const m = window.median || window.gonative; if (m && m.onesignal && m.onesignal.register) m.onesignal.register(); } catch (e) {}
}
async function showPerm() {
  const p = $("#perm");
  const notif = "Notification" in window ? Notification.permission : "unsupported";
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  const row = (icon, title, sub, state) => `<div class="pr"><span class="pi">${icon}</span><div class="tx"><b>${title}</b><small>${sub}</small></div>${
    state === "granted" ? '<span class="ok">✓ Allowed</span>' : state === "denied" ? '<span class="na">Blocked in settings</span>' : state === "unsupported" ? '<span class="na">Not supported here</span>' : '<span class="na">Not allowed yet</span>'}</div>`;
  p.innerHTML = `<div class="box"><h2>Allow access</h2><p class="sub">One tap to let emaindi alert you about new messages, keep recent chats saved on this phone, and use the microphone for voice messages and calls.</p>
    ${row("🔔", "Notifications", "Get alerted when a new message arrives.", notif)}
    ${row("🎤", "Microphone", "For voice messages and voice calls. Asked when you allow all.", "default")}
    ${row("💾", "Saved chats", "Keeps recent chats on this device so the app opens fast and works offline.", persisted === null ? "unsupported" : persisted ? "granted" : "default")}
    <button class="btn" data-a="all" style="width:100%">Allow all</button><button class="btn ghost" data-a="done" style="width:100%">Not now</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === "done" || e.target === p) { closeModal(p); localStorage.setItem("perm-seen", "1"); return; }
    if (a === "all") { await allowAll(); localStorage.setItem("perm-seen", "1"); showPerm(); }
  };
}

/* ---------- start ---------- */
history.replaceState({list: 1}, "");
$("#meBtn").addEventListener("click", showMyQr);        // CHANGED: was showInfo(me.uid), now opens my QR code
$("#scanBtn").addEventListener("click", openScan);
$("#grpBtn").addEventListener("click", newGroup);
$("#menuBtn").addEventListener("click", homeMenu);   // Read all / Settings   // GROUP: new group button      // NEW: scanner button
startSession(() => {
  renderMe(); renderList();
  initCalls();
  initPush(me.uid).catch(() => {});   // NEW: keep this phone registered for notifications
  if (!localStorage.getItem("perm-seen")) setTimeout(showPerm, 900);
});
fitViewport();
