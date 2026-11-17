// home.js - the chat list page. Opening a chat goes to chat.html.
import {db, doc, getDocs, query, collection, where, orderBy, limit} from "./fire.js";
import {$, esc, ms, me, chats, people, hooks, watch, peerOf, chatId, visibleChat, nameOf, avatar, listTime, preview, isTyping,
  lockedIds, isLocked, isUnlocked, relock, askUnlock, changeLockPin, toggleLock, deleteChat, openModal, closeModal, onBack,
  showInfo, hydrate, startSession, saveCache, dialog, toast, fitViewport} from "./common.js";
import {initCalls} from "./call.js";

let found = [], searchTimer = null, lockView = false, needRelock = false;

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
    const o = peerOf(c), p = people[o] || {};
    return !q || [nameOf(o), p.phone, p.email].join(" ").toLowerCase().includes(q);
  });
  let h = "";
  if (lockView) h += lockHeaderRows();
  else if (!q) { const n = chats.filter((c) => visibleChat(c) && lockedSet.has(c.id)).length; if (n) h += lockFolderRow(n); }
  if (lockView && !rows.length) h += '<div class="none">No locked chats yet. Long-press a chat and choose “Lock chat”.</div>';
  const fresh = found;   // CHANGED: your own account is now included in search results too
  if (q && fresh.length) h += '<div class="sec">On emaindi</div>' + fresh.map((u) => `<button class="row" data-uid="${u.uid}">${avatar(u.uid)}<div class="meta"><div class="nm">${esc(nameOf(u.uid))}</div><div class="pv">${esc(u.phone || u.email)}</div></div></button>`).join("");
  if (rows.length) {
    if (q) h += '<div class="sec">Chats</div>';
    h += rows.map((c) => {
      const o = peerOf(c), n = (c.unread && c.unread[me.uid]) || 0, mine = c.lastSender === me.uid;
      const t = ms(c.lastMessageAt);
      return `<button class="row" data-chat="1" data-uid="${o}">${avatar(o)}<div class="meta">
        <div class="line1"><span class="nm">${esc(nameOf(o))}</span><span class="tm ${n ? "new" : ""}">${listTime(t)}</span></div>
        <div class="line2"><span class="pv">${mine ? '<span class="tk">✓</span>' : ""}${isTyping(c) ? '<span class="typ">typing…</span>' : esc(preview(c))}</span>${n ? `<span class="badge">${n}</span>` : ""}</div></div></button>`;
    }).join("");
  }
  $("#rows").innerHTML = h || `<div class="none">${q ? "No chats found. Enter the full phone number (with country code) or email to find someone." : "No chats yet. Search a phone number or email above to start one."}</div>`;
}
hooks.render = renderList;

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
  if (r) openChat(r.dataset.uid).catch((err) => { console.error(err); toast("Could not open chat: " + (err.code || err.message)); });
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
    if (a === "lock") setTimeout(async () => { await toggleLock(uid); renderList(); }, 250);
    if (a === "del") setTimeout(() => deleteChat(uid), 250);
  };
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
function netBanner() { const b = $("#offline"); if (b) b.hidden = navigator.onLine; }
addEventListener("online", () => { netBanner(); prefetchRecent(); });
addEventListener("offline", netBanner);
netBanner();

/* ---------- permissions: notifications + storage ---------- */
async function allowAll() {
  try { if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission(); } catch (e) {}
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
$("#scanBtn").addEventListener("click", openScan);      // NEW: scanner button
hydrate();
startSession(() => {
  renderMe(); renderList();
  initCalls();
  if (!localStorage.getItem("perm-seen")) setTimeout(showPerm, 900);
});
fitViewport();
