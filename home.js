// home.js - the chat list page. Opening a chat goes to chat.html.
import {db, doc, getDocs, setDoc, updateDoc, query, collection, where, orderBy, limit, serverTimestamp} from "./fire.js";
import {$, esc, ms, me, chats, people, hooks, watch, peerOf, chatId, visibleChat, nameOf, avatar, listTime, preview, isTyping,
  lockedIds, isLocked, isUnlocked, relock, askUnlock, changeLockPin, toggleLock, deleteChat, openModal, closeModal, onBack,
  showInfo, startSession, saveCache, dialog, toast, fitViewport, groupAvatar, pickPeople, toggleLockById, mySet, isBlocked, toggleBlock, contacts, isMuted, isArchived, archivedIds, setMute, toggleArchive, dayLabel, hm, isPinned, togglePin, pinnedIds, myDeviceId} from "./common.js";
import {initCalls, startCall} from "./call.js";
import {deleteDoc} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
// push.js is loaded only when needed, so the app still works even if that file is missing or broken
const initPush = (uid) => import("./push.js").then((m) => m.initPush(uid)).catch((e) => console.warn("Push:", e));

let found = [], searchTimer = null, lockView = false, archView = false, needRelock = false;

// NEW: in a chat with yourself there is no "other" person, so fall back to your own uid
const peer = (c) => peerOf(c) || me.uid;

// pinned chats now live in common.js (saved in your account, so they survive logout and work on every device)

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
  const archSet = new Set(archivedIds());
  // main list hides archived chats (but searching still finds them); the Archived folder shows only archived ones
  const inView = (c) => (lockView ? lockedSet.has(c.id) : !lockedSet.has(c.id) && (archView ? archSet.has(c.id) : q || !archSet.has(c.id)));
  const rows = chats.filter(visibleChat).filter(inView).filter((c) => {
    if (c.isGroup) return !q || (c.name || "").toLowerCase().includes(q);   // GROUP: search by group name
    const o = peer(c), p = people[o] || {};
    return !q || [nameOf(o), p.phone, p.email].join(" ").toLowerCase().includes(q);
  });
  const pins = pinnedIds();
  rows.sort((a, b) => (pins.includes(b.id) ? 1 : 0) - (pins.includes(a.id) ? 1 : 0));   // NEW: pinned chats stay on top
  let h = "";
  if (lockView) h += lockHeaderRows();
  else if (archView) h += lockRow("aback", "←", "Archived chats", "Tap to go back");
  else if (!q) {
    const n = chats.filter((c) => visibleChat(c) && lockedSet.has(c.id)).length; if (n) h += lockFolderRow(n);
    const ar = chats.filter((c) => visibleChat(c) && !lockedSet.has(c.id) && archSet.has(c.id));
    if (ar.length) { const un = ar.reduce((s, c) => s + ((c.unread && c.unread[me.uid]) || 0), 0); h += lockRow("aopen", "🗄️", "Archived", ar.length + (ar.length === 1 ? " chat" : " chats") + (un ? " · " + un + " unread" : "")); }
  }
  if (lockView && !rows.length) h += '<div class="none">No locked chats yet. Long-press a chat and choose “Lock chat”.</div>';
  if (archView && !rows.length) h += '<div class="none">No archived chats. Long-press a chat and choose “Archive”.</div>';
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
        <div class="line1"><span class="nm">${esc(c.name || "Group")}${isMuted(c.id) ? " 🔇" : ""}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${esc(who + preview(c))}</span>${(n || pinned) ? `<span style="display:flex;align-items:center;gap:6px">${pinned ? '<span style="font-size:12px">📌</span>' : ""}${n ? `<span class="badge">${n}</span>` : ""}</span>` : ""}</div></div></button>`;
      }
      const o = peer(c), self = o === me.uid;
      const n = self ? 0 : (c.unread && c.unread[me.uid]) || 0, mine = !self && c.lastSender === me.uid;   // self chat: no unread badge, no tick
      const t = ms(c.lastMessageAt), pinned = pins.includes(c.id);
      return `<button class="row" data-chat="1" data-uid="${o}">${avatar(o)}<div class="meta">
        <div class="line1"><span class="nm">${esc(nameOf(o))}${self ? " (You)" : ""}${isMuted(c.id) ? " 🔇" : ""}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${isTyping(c) ? '<span class="typ">typing…</span>' : isBlocked(o) ? "🚫 Blocked" : esc(preview(c))}</span>${(n || pinned) ? `<span style="display:flex;align-items:center;gap:6px">${pinned ? '<span style="font-size:12px">📌</span>' : ""}${n ? `<span class="badge">${n}</span>` : ""}</span>` : ""}</div></div></button>`;
    }).join("");
  }
  if (sugg.length) h += '<div class="sec">Suggestions</div>' + sugg.map((u) => `<button class="row" data-uid="${esc(u)}">${avatar(u)}<div class="meta"><div class="nm">${esc(nameOf(u))}</div><div class="pv">${esc((people[u] || {}).phone || (people[u] || {}).email || "")}</div></div></button>`).join("");
  $("#rows").innerHTML = h || `<div class="none">${q ? "No chats found. Enter the full phone number (with country code) or email to find someone." : "No chats yet. Search a phone number or email above to start one."}</div>`;
}
hooks.render = () => { renderList(); updateTabBadge(); };

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
  if (a === "aopen") { history.pushState({arch: 1}, ""); archView = true; renderList(); window.scrollTo(0, 0); }
  if (a === "aback") { if (history.state && history.state.arch) history.back(); else { archView = false; renderList(); } }
  if (a === "pin") await changeLockPin();
}
onBack((s) => { if (!s.lock && lockView) { lockView = false; relock(); renderList(); } if (!s.arch && archView) { archView = false; renderList(); } });
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
function muteMenu(cid) {   // choose how long to mute
  const s = $("#sheet");
  s.innerHTML = `<div class="box"><div style="padding:12px 16px 8px;text-align:center;font-weight:700;opacity:.85">Mute notifications</div>
    <button data-a="8h">🔇 For 8 hours</button><button data-a="1w">🔇 For 1 week</button><button data-a="all">🔇 Always</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === "8h") setMute(cid, Date.now() + 8 * 3600e3).then((ok) => ok && toast("Muted for 8 hours."));
    if (a === "1w") setMute(cid, Date.now() + 7 * 24 * 3600e3).then((ok) => ok && toast("Muted for 1 week."));
    if (a === "all") setMute(cid, 0).then((ok) => ok && toast("Muted."));
  };
}
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
    <button data-a="mute">${isMuted(cid) ? "🔔 Unmute" : "🔇 Mute"}</button>
    <button data-a="arch">${isArchived(cid) ? "📤 Unarchive" : "🗄️ Archive"}</button>
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
    if (a === "mute") { if (isMuted(cid)) setMute(cid).then((ok) => ok && toast("Unmuted.")); else setTimeout(() => muteMenu(cid), 250); }
    if (a === "arch") toggleArchive(cid);
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
function homeMenu() {   // the three-dot menu: a panel under the header, top right
  if (!me) return;
  const old = document.getElementById("dd");
  if (old) { old.remove(); return; }
  const n = unreadChats().length, dark = document.documentElement.dataset.theme === "dark";
  const top = document.querySelector(".top").getBoundingClientRect().bottom;
  const d = document.createElement("div");
  d.id = "dd";
  d.style.cssText = "position:fixed;inset:0;z-index:15";   // invisible backdrop: tapping outside closes the menu
  d.innerHTML = `<div style="position:absolute;top:${top + 4}px;right:10px;min-width:15rem;background:${dark ? "#17213a" : "#fff"};color:${dark ? "#f1f3f9" : "#14213D"};border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.3);padding:6px">
    <button data-a="grp">👥 New group</button>
    <button data-a="dev">💻 Linked devices</button>
    <button data-a="read">✓✓ Read all${n ? " (" + n + ")" : ""}</button>
    <button data-a="set">⚙️ Settings</button></div>`;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { d.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  d.onclick = (e) => {
    const a = e.target.closest("[data-a]");
    close();
    if (!a) return;
    const act = a.dataset.a;
    if (act === "grp") setTimeout(newGroup, 120);
    if (act === "dev") setTimeout(showDevices, 120);
    if (act === "read") readAll();
    if (act === "set") setTimeout(() => (location.href = "settings.html"), 120);
  };
  document.body.appendChild(d);
}

/* ---------- linked devices: where this account is logged in ---------- */
async function showDevices() {
  const p = $("#info"), mine = myDeviceId();
  p.innerHTML = '<div class="box"><h2>Linked devices</h2><div class="num">Loading…</div><button class="btn ghost" data-a="x">Close</button></div>';
  openModal(p);
  const load = async () => {
    let list = [];
    try {
      const snap = await getDocs(collection(db, "users", me.uid, "sessions"));
      list = snap.docs.map((d) => ({id: d.id, ...d.data({serverTimestamps: "estimate"})}));
    } catch (err) { console.error(err); const nm = p.querySelector(".num"); if (nm) nm.textContent = "Could not load your devices."; return; }
    const now = Date.now(), fresh = [];
    for (const d of list) {
      if (d.id !== mine && now - ms(d.lastActive) > 45 * 864e5) deleteDoc(doc(db, "users", me.uid, "sessions", d.id)).catch(() => {});   // forgotten devices disappear after 45 days
      else fresh.push(d);
    }
    fresh.sort((a, b) => (a.id === mine ? -1 : b.id === mine ? 1 : ms(b.lastActive) - ms(a.lastActive)));
    const others = fresh.filter((d) => d.id !== mine);
    const row = (d) => {
      const isMine = d.id === mine, t = ms(d.lastActive);
      const sub = isMine ? '<span style="color:#1a9d4b;font-weight:700">This device</span>' : now - t < 180000 ? "Active now" : "Last active " + esc(dayLabel(t)) + " " + hm(t);
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 4px"><span style="font-size:26px">${d.kind === "mobile" ? "📱" : "💻"}</span><div style="flex:1;min-width:0;text-align:left"><div style="font-weight:600">${esc(d.name || "Device")}</div><small style="opacity:.7">${sub}</small></div>${isMine ? "" : `<button class="btn ghost danger" data-out="${esc(d.id)}" style="width:auto;padding:6px 12px;margin:0">Log out</button>`}</div>`;
    };
    p.innerHTML = `<div class="box"><h2>Linked devices</h2><div class="num">${fresh.length} ${fresh.length === 1 ? "device is" : "devices are"} logged in with this account</div>
      <div style="max-height:46vh;overflow:auto;margin:8px 0">${fresh.map(row).join("")}</div>
      ${others.length ? '<button class="btn ghost danger" data-a="all">Log out all other devices</button>' : ""}
      <small style="display:block;opacity:.6;margin:6px 0 10px">Logging out a device signs it out of your account right away. A device shows up here after it opens the latest version of the app.</small>
      <button class="btn ghost" data-a="x">Close</button></div>`;
  };
  p.onclick = async (e) => {
    const t = e.target.closest("[data-out],[data-a]") || e.target, out = t.dataset.out, a = t.dataset.a;
    if (!out && !a) { if (e.target === p) closeModal(p); return; }
    if (a === "x") return closeModal(p);
    try {
      if (out) { await deleteDoc(doc(db, "users", me.uid, "sessions", out)); toast("Device logged out."); }
      if (a === "all") {
        const snap = await getDocs(collection(db, "users", me.uid, "sessions"));
        await Promise.all(snap.docs.filter((d) => d.id !== mine).map((d) => deleteDoc(d.ref)));
        toast("All other devices logged out.");
      }
    } catch (err) { console.error(err); toast("Could not log out the device."); }
    load();
  };
  load();
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
hooks.chatsChanged = () => { prefetchRecent(); if (tab === "calls" && !callCache.at && !callsLoading) loadCalls(true); };
// NEW: save the chat list on the phone right before the page is closed, reloaded or hidden (common.js already saves on every change)
const saveNow = () => { try { saveCache(true); } catch (e) {} };
addEventListener("pagehide", saveNow);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveNow(); });
function netBanner() { const b = $("#offline"); if (b) b.hidden = navigator.onLine; }
addEventListener("online", () => { netBanner(); prefetchRecent(); });
addEventListener("offline", netBanner);
netBanner();

/* ---------- permissions: the phone's own pop-ups, asked once on the first tap ---------- */
async function askPermissions() {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) {}
  try { if (me) await initPush(me.uid); } catch (e) {}   // register this phone for notifications when the app is closed
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  try { if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) { const st = await navigator.mediaDevices.getUserMedia({audio: true}); st.getTracks().forEach((t) => t.stop()); } } catch (e) {}   // microphone, for voice messages and calls
  try { const m = window.median || window.gonative; if (m && m.onesignal && m.onesignal.register) m.onesignal.register(); } catch (e) {}   // Median.co / GoNative wrapper
  try { localStorage.setItem("perm-seen", "1"); } catch (e) {}
}
function askOnFirstTap() {   // browsers only show these pop-ups after a tap, so we wait for the first one
  let seen = false; try { seen = !!localStorage.getItem("perm-seen"); } catch (e) {}
  if (seen) return;
  const go = () => { document.removeEventListener("click", go, true); askPermissions(); };
  document.addEventListener("click", go, true);
}

/* ---------- bottom bar: Messages / Calls ---------- */
let tab = "chats", callCache = {at: 0, items: []}, callsLoading = false;
function updateTabBadge() {
  const b = $("#tabChatsBadge"); if (!b || !me) return;
  const n = unreadChats().length;
  b.textContent = n > 99 ? "99+" : String(n); b.hidden = !n;
}
function setTab(t) {
  tab = t;
  try { sessionStorage.setItem("homeTab", t); } catch (e) {}
  $("#rows").hidden = t !== "chats"; $("#calls").hidden = t !== "calls"; document.querySelector(".search").hidden = t !== "chats";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  if (t === "calls") loadCalls(); else renderList();
}
const fmtDur = (s) => (s >= 3600 ? Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m" : s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s");

// the call history is read from the call messages stored in each chat (newest first)
async function loadCalls(force) {
  if (!me) return;
  if (callCache.items.length) paintCalls(); else $("#calls").innerHTML = '<div class="none">Loading calls…</div>';
  if (!force && Date.now() - callCache.at < 20000) { if (!callCache.items.length) paintCalls(); return; }
  if (callsLoading) return;
  callsLoading = true;
  try {
    const locked = new Set(lockedIds());
    const targets = chats.filter((c) => visibleChat(c) && !c.isGroup && !locked.has(c.id) && peerOf(c) !== me.uid).slice(0, 80);
    const out = [];
    await Promise.all(targets.map(async (c) => {
      try {
        const s = await getDocs(query(collection(db, "chats", c.id, "messages"), where("type", "==", "call")));
        const gone = ms(c.deletedAt && c.deletedAt[me.uid]);
        s.docs.forEach((d) => {
          const m = d.data({serverTimestamps: "estimate"}), t = ms(m.createdAt);
          if (t > gone && !(m.deletedFor || []).includes(me.uid)) out.push({peer: peerOf(c), mine: m.senderId === me.uid, status: m.callStatus, dur: m.dur || 0, t});
        });
      } catch (e) { console.warn("Call history:", c.id, e.code || e); }
    }));
    out.sort((x, y) => y.t - x.t);
    callCache = {at: targets.length ? Date.now() : 0, items: out.slice(0, 200)};
  } finally { callsLoading = false; }
  if (tab === "calls") paintCalls();
}
function paintCalls() {
  const box = $("#calls"), items = callCache.items;
  if (!items.length) { box.innerHTML = '<div class="none">No calls yet.<br>Open a chat and tap the phone to call.</div>'; return; }
  let h = "", last = "";
  for (const it of items) {
    const day = dayLabel(it.t);
    if (day !== last) { h += `<div class="sec">${esc(day)}</div>`; last = day; }
    const answered = it.status === "ended", declined = it.status === "declined", missed = !it.mine && !answered && !declined;
    const label = answered ? (it.mine ? "Outgoing" : "Incoming") : declined ? "Declined" : it.mine ? "No answer" : "Missed";
    const color = missed ? "#d93025" : answered ? "#1a9d4b" : "inherit";
    h += `<div class="row" data-peer="${esc(it.peer)}" role="button" tabindex="0">${avatar(it.peer)}<div class="meta"><div class="line1"><span class="nm" style="${missed ? "color:#d93025" : ""}">${esc(nameOf(it.peer))}</span><span class="tm">${hm(it.t)}</span></div><div class="line2"><span class="pv"><span style="color:${color};font-weight:700">${it.mine ? "↗" : "↙"}</span> ${label}${answered && it.dur ? " · " + fmtDur(it.dur) : ""}</span></div></div><button class="cbtn" data-call="${esc(it.peer)}" aria-label="Call"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg></button></div>`;
  }
  box.innerHTML = h;
}
$("#calls").addEventListener("click", async (e) => {
  const cb = e.target.closest("[data-call]");
  if (cb) {   // the phone button: call this person straight away
    const uid = cb.dataset.call;
    if (isBlocked(uid)) return toast("You blocked this contact. Unblock to call.");
    try { await startCall(uid); } catch (err) { console.error(err); toast("Could not start the call."); }
    return;
  }
  const r = e.target.closest(".row[data-peer]");
  if (r) openChat(r.dataset.peer).catch((err) => { console.error(err); toast("Could not open chat: " + (err.code || err.message)); });
});
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

/* ---------- start ---------- */
history.replaceState({list: 1}, "");
$("#meBtn").addEventListener("click", showMyQr);        // CHANGED: was showInfo(me.uid), now opens my QR code
$("#scanBtn").addEventListener("click", openScan);
$("#menuBtn").addEventListener("click", homeMenu);   // Read all / Settings   // GROUP: new group button      // NEW: scanner button
startSession(() => {
  try { const nx = localStorage.getItem("joinNext"); if (nx) { localStorage.removeItem("joinNext"); location.replace(nx); return; } } catch (e) {}   // came here from a group invite link
  renderMe(); renderList(); updateTabBadge();
  try { if (sessionStorage.getItem("homeTab") === "calls") setTab("calls"); } catch (e) {}
  initCalls();
  initPush(me.uid).catch(() => {});   // NEW: keep this phone registered for notifications
  askOnFirstTap();   // the phone's own permission pop-ups (replaces the old custom screen)
});
fitViewport();
