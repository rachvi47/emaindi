// chat.js - one conversation (chat.html?u=<other person's uid>).
import {db, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, orderBy, onSnapshot, serverTimestamp, increment, arrayUnion} from "./fire.js";
import {$, esc, ms, hm, me, chats, people, hooks, watch, chatId, nameOf, avatar, dayLabel, online, hidden, mySet, isTyping,
  encryptText, decryptText, isLocked, isUnlocked, askUnlock, relock, openModal, closeModal, showInfo, startSession,
  dialog, toast, fitViewport, lsFlag, groupAvatar, pickPeople} from "./common.js";
import {initCalls, startCall} from "./call.js";
import {readChatMessages, saveChatMessages} from "./offline.js";

const qs = new URLSearchParams(location.search);
const groupId = qs.get("g"), GROUP = !!groupId;          // GROUP: chat.html?g=<group id>
const peerUid = GROUP ? "" : qs.get("u");
if (!peerUid && !GROUP) location.replace("home.html");
const MAX_MEDIA = 720000;      // a Firestore document must stay under 1 MB, so photos / voice are kept below this size

let cid = "", cur = null, msgs = [], raw = [], replyTo = null, msgUnsub = null, snapSeq = 0, listening = false, unlocked = false, needRelock = false;
const goHome = () => location.replace("home.html");
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.round(s) % 60).padStart(2, "0");
const msgPreview = (m) => m.deleted ? "🚫 Deleted message" : m.type === "image" ? "📷 " + (m.text || "Photo") : m.type === "voice" ? "🎤 Voice message" : m.type === "call" ? "📞 " + m.text : m.text;
const isSelf = () => !GROUP && !!me && peerUid === me.uid;   // NEW: a chat with yourself ("Message yourself")

/* ---------- header ---------- */
function renderHead() {
  if (GROUP) {
    const names = ((cur && cur.participants) || []).map((u) => (u === me.uid ? "You" : nameOf(u))).join(", ");
    $("#peer").innerHTML = `${groupAvatar(cid, cur && cur.name, "sm")}<div style="min-width:0"><div class="nm">${esc((cur && cur.name) || "Group")}</div><small style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(names)}</small></div>`;
    return;
  }
  const u = people[peerUid] || {}, self = isSelf();
  // CHANGED: in a chat with yourself there is no online / typing / last seen status
  const st = self ? "Message yourself" : isTyping(cur) ? '<span class="typing-txt">typing<span class="tdots"><i></i><i></i><i></i></span></span>' : hidden(u) ? "" : online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
  $("#peer").innerHTML = `${avatar(peerUid, "sm")}<div style="min-width:0"><div class="nm">${esc(nameOf(peerUid))}${self ? " (You)" : ""}</div><small>${st}</small></div>`;
}
$("#peer").addEventListener("click", () => (GROUP ? showGroupInfo() : showInfo(peerUid)));
$("#back").addEventListener("click", () => (history.length > 1 ? history.back() : goHome()));
$("#callBtn").addEventListener("click", () => startCall(peerUid));

/* ---------- live data ---------- */
hooks.viewing = () => (unlocked ? cid : null);
hooks.render = () => { if (unlocked) renderHead(); };
const seenNames = {};
hooks.peerChanged = (uid) => {
  if (!unlocked) return;
  if (GROUP) { renderHead(); if (seenNames[uid] !== nameOf(uid)) { seenNames[uid] = nameOf(uid); renderMsgs(); } return; }   // GROUP: redraw only when a name changed
  if (uid === peerUid) renderHead();
};
hooks.redecrypt = () => decodeAndShow();
hooks.chatDeleted = goHome;
hooks.chatLockChanged = (uid, st) => { if (st === "locked") goHome(); };
let seenInList = false;
hooks.chatsChanged = () => {
  if (!cid || !unlocked) return;
  const c = chats.find((x) => x.id === cid);
  if (c) { cur = c; seenInList = true; if (GROUP) (c.participants || []).forEach(watch); }
  else if (GROUP && seenInList) { toast("You are no longer in this group."); setTimeout(goHome, 1200); return; }   // GROUP: removed by an admin
  if (!listening) { listening = true; begin(!!c || GROUP); }   // a group is never created from here
  renderHead(); renderMsgs(); markRead();
};
// hides: messages you deleted for yourself, messages from before you deleted the chat, and (groups) messages from before you joined
const visibleMsg = (m) => !(m.deletedFor || []).includes(me.uid)
  && ms(m.createdAt) > ms(cur && cur.deletedAt && cur.deletedAt[me.uid])
  && ms(m.createdAt) >= ms(cur && cur.joinedAt && cur.joinedAt[me.uid]);
async function begin(known) {
  if (!known) {     // a brand-new chat: create it (merge, so nothing existing is overwritten)
    try { await setDoc(doc(db, "chats", cid), {participants: [me.uid, peerUid].sort()}, {merge: true}); }
    catch (err) { console.error(err); toast("Could not open chat: " + (err.code || err.message)); return; }
  }
  msgUnsub && msgUnsub();
  // Paint recent messages from this account's local IndexedDB immediately, before network sync.
  try {
    const cached = await readChatMessages(me.uid, cid);
    if (cached.length && unlocked) {
      raw = cached.filter(visibleMsg);
      await decodeAndShow();
    }
  } catch (e) { console.warn("Local message cache unavailable:", e); }
  msgUnsub = onSnapshot(query(collection(db, "chats", cid, "messages"), orderBy("createdAt")), (s) => {
    raw = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites, ...d.data({serverTimestamps: "estimate"})}))
      .filter(visibleMsg);
    saveChatMessages(me.uid, cid, raw).catch((e) => console.warn("Could not update local message cache:", e));
    decodeAndShow();
  }, (err) => { console.error("Message sync failed:", err); toast("Messages could not sync: " + (err.code || err.message || "check your connection")); });
}
async function decodeAndShow() {
  const seq = ++snapSeq;
  const out = await Promise.all(raw.map(async (m) => ({
    ...m,
    text: await decryptText(peerUid, m.text),
    replyTo: m.replyTo ? {...m.replyTo, text: await decryptText(peerUid, m.replyTo.text)} : null,
  })));
  if (seq !== snapSeq) return;
  msgs = out; renderMsgs(); markRead();
}

/* ---------- drawing the messages ---------- */
function tick(m) {
  if (m.pending) return '<span class="tk">🕓</span>';
  if (GROUP) {   // GROUP ticks: one tick = sent, grey ✓✓ = everyone received it, blue ✓✓ = everyone read it
    const others = ((cur && cur.participants) || []).filter((u) => u !== me.uid), t = ms(m.createdAt);
    if (others.length && !mySet().noReceipts && others.every((u) => ms(cur.lastRead && cur.lastRead[u]) >= t)) return '<span class="tk r">✓✓</span>';
    if (others.length && others.every((u) => ms(cur.deliveredAt && cur.deliveredAt[u]) >= t)) return '<span class="tk">✓✓</span>';
    return '<span class="tk">✓</span>';
  }
  if (isSelf()) return '<span class="tk r">✓✓</span>';   // NEW: your own notes are always "read"
  const t = ms(m.createdAt);
  const noRx = mySet().noReceipts || (people[peerUid] && people[peerUid].settings && people[peerUid].settings.noReceipts);
  if (!noRx && ms(cur.lastRead && cur.lastRead[peerUid]) >= t) return '<span class="tk r">✓✓</span>';
  if (ms(cur.deliveredAt && cur.deliveredAt[peerUid]) >= t) return '<span class="tk">✓✓</span>';
  return '<span class="tk">✓</span>';
}
const blobUrls = {};
function dataUrlToBlob(u) {
  const [head, b64] = u.split(","), bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], {type: (head.match(/:(.*?)[;,]/) || [])[1] || "application/octet-stream"});
}
const mediaUrl = (m, f) => blobUrls[m.id + f] || (blobUrls[m.id + f] = URL.createObjectURL(dataUrlToBlob(m[f])));   // short blob: links keep the page fast
function bodyHtml(m) {
  if (m.deleted) return '<div class="t">🚫 This message was deleted</div>';
  if (m.type === "image" && m.img) return `<img class="mimg" src="${mediaUrl(m, "img")}" alt="Photo" loading="lazy" decoding="async">${m.text ? `<div class="t">${esc(m.text)}</div>` : ""}`;
  if (m.type === "voice" && m.audio) return `<div class="vm" data-id="${m.id}"><button class="vp" aria-label="Play">▶</button><div class="vbar"><i></i></div><span class="vd">${fmt(m.dur || 0)}</span></div>`;
  return `<div class="t">${esc(m.text)}</div>`;
}
function senderTag(m, mine) {   // GROUP: the sender's name above each message from someone else
  if (!GROUP || mine || m.deleted) return "";
  let h = 0; for (const ch of m.senderId || "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<div style="font-size:12px;font-weight:700;margin-bottom:2px;color:hsl(${h} 60% 55%)">${esc(nameOf(m.senderId))}</div>`;
}
function callLine(m, mine) {
  if (m.callStatus === "ended") return "Voice call" + (m.dur ? " · " + fmt(m.dur) : "");
  if (m.callStatus === "declined") return mine ? "Call declined" : "You declined a voice call";
  return mine ? "No answer" : "Missed voice call";
}
function renderMsgs(force) {
  if (!cur) return;
  const box = $("#msgs"), stick = force || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let h = "", last = "";
  for (const m of msgs) {
    const t = ms(m.createdAt), d = dayLabel(t), mine = m.senderId === me.uid;
    if (d !== last) { h += `<div class="day">${d}</div>`; last = d; }
    if (m.type === "system") { h += `<div class="day">${esc(m.text)}</div>`; continue; }   // GROUP: "Ravi added Sam" etc.
    if (m.type === "call") { h += `<div class="callmsg ${m.callStatus === "ended" ? "" : "miss"}">📞 ${esc(callLine(m, mine))} · ${hm(t)}</div>`; continue; }
    const q = m.replyTo ? `<div class="quote"><b>${esc(m.replyTo.name)}</b>${esc(m.replyTo.text)}</div>` : "";
    h += `<div class="msg ${mine ? "me" : ""} ${m.deleted ? "del" : ""}" data-id="${m.id}">${senderTag(m, mine)}${m.deleted ? "" : q}${bodyHtml(m)}<div class="ft">${hm(t)} ${mine ? tick(m) : ""}</div></div>`;
  }
  if (isTyping(cur) && !isSelf()) h += '<div class="msg typing"><i></i><i></i><i></i></div>';
  box.innerHTML = h;
  paintVoice();
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------- sending ---------- */
async function sendMessage(fields, previewText) {
  if (!cid) return false;
  let text = "", last, rep = null;
  try {
    text = fields.text ? await encryptText(peerUid, fields.text) : "";
    last = await encryptText(peerUid, previewText.slice(0, 200));
    if (replyTo) rep = {text: await encryptText(peerUid, msgPreview(replyTo).slice(0, 100)), name: replyTo.senderId === me.uid ? "You" : nameOf(replyTo.senderId)};
  } catch (err) {
    console.error(err);
    toast(err.message === "no-key" ? "This person hasn't opened the updated app yet, so the message can't be encrypted." : "Could not prepare the message.");
    return false;
  }
  clearReply(); stopTyping();
  const fail = (err) => { console.error(err); toast("Message could not be sent."); };
  // not awaited on purpose: offline, these wait in the phone's queue and go out when the internet returns
  addDoc(collection(db, "chats", cid, "messages"), {senderId: me.uid, createdAt: serverTimestamp(), replyTo: rep, deleted: false, ...fields, text}).catch(fail);
  // CHANGED: a message to yourself is never "unread"
  const chatUpdate = {lastMessage: last, lastMessageAt: serverTimestamp(), lastSender: me.uid};
  if (GROUP) ((cur && cur.participants) || []).filter((u) => u !== me.uid).forEach((u) => (chatUpdate["unread." + u] = increment(1)));
  else if (!isSelf()) chatUpdate["unread." + peerUid] = increment(1);
  updateDoc(doc(db, "chats", cid), chatUpdate).catch(fail);
  return true;
}
async function sendText() {
  const t = $("#txt").value.trim();
  if (!t) return;
  if (await sendMessage({text: t}, t)) { $("#txt").value = ""; grow(); updateSendMic(); }
}
function grow() { const t = $("#txt"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 120) + "px"; }
function updateSendMic() { const has = $("#txt").value.trim().length > 0; $("#send").hidden = !has; $("#mic").hidden = has; }
$("#send").addEventListener("click", sendText);
$("#txt").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && lsFlag("enterSend", true)) { e.preventDefault(); sendText(); } });
$("#txt").addEventListener("focus", () => setTimeout(fitViewport, 300));

/* ---------- typing indicator (what the other person sees) ---------- */
let typingOn = false, typingSentAt = 0;
function sendTyping(on) {
  if (!cid || isSelf() || GROUP) return;      // CHANGED: nobody to show "typing…" to in a chat with yourself
  if (on) { if (Date.now() - typingSentAt < 2500) return; typingSentAt = Date.now(); typingOn = true; }
  else { if (!typingOn) return; typingOn = false; typingSentAt = 0; }
  updateDoc(doc(db, "chats", cid), {["typing." + me.uid]: on ? serverTimestamp() : 0}).catch(() => {});
}
const stopTyping = () => sendTyping(false);
$("#txt").addEventListener("input", () => { grow(); updateSendMic(); $("#txt").value.trim() ? sendTyping(true) : stopTyping(); });
$("#txt").addEventListener("blur", stopTyping);

/* ---------- photos ---------- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      let scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      for (let round = 0; round < 4; round++) {
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        for (let q = 0.78; q >= 0.4; q -= 0.12) {
          const out = c.toDataURL("image/jpeg", q);
          if (out.length <= MAX_MEDIA) return resolve({data: out, w, h});
        }
        scale *= 0.7;
      }
      resolve(null);
    };
    img.src = url;
  });
}
function previewImage(src) {
  return new Promise((res) => {
    const d = $("#dlg");
    d.innerHTML = '<div class="dbox"><h3>Send photo</h3><img class="pimg" alt=""><input id="dIn" type="text" placeholder="Add a caption…" maxlength="500" autocomplete="off"><div class="dact"><button data-a="c">Cancel</button><button data-a="o">Send</button></div></div>';
    d.querySelector(".pimg").src = src;
    d.hidden = false;
    const inp = $("#dIn"), done = (v) => { d.hidden = true; d.onclick = null; res(v); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(inp.value.trim()); });
    d.onclick = (e) => { const a = e.target.dataset.a; if (a === "o") done(inp.value.trim()); else if (a === "c" || e.target === d) done(null); };
  });
}
$("#attach").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", async () => {
  const f = $("#file").files[0]; $("#file").value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) return toast("Please choose a photo.");
  let img;
  try { img = await compressImage(f); } catch (e) { return toast("Could not read that photo. Try a JPEG or PNG."); }
  if (!img) return toast("That photo is too large to send.");
  const cap = await previewImage(img.data);
  if (cap === null) return;
  sendMessage({type: "image", img: img.data, w: img.w, h: img.h, text: cap}, "📷 " + (cap || "Photo"));
});
function openViewer(src) { const v = $("#viewer"); v.querySelector("img").src = src; openModal(v); }
$("#vx").addEventListener("click", () => closeModal($("#viewer")));
$("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") closeModal($("#viewer")); });

/* ---------- voice messages ---------- */
let rec = null;
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function startRec() {
  if (rec) return;
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast("Voice messages aren't supported on this device or page (needs https).");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); } catch (e) { return toast("Allow the microphone to record voice messages."); }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const mr = new MediaRecorder(stream, {...(mime ? {mimeType: mime} : {}), audioBitsPerSecond: 24000});
  const chunks = [];
  mr.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  mr.start(1000);
  rec = {mr, stream, chunks, t0: Date.now(), timer: null};
  $("#composer").hidden = true; $("#recbar").hidden = false; $("#recTime").textContent = "0:00";
  rec.timer = setInterval(() => {
    const s = (Date.now() - rec.t0) / 1000;
    $("#recTime").textContent = fmt(s);
    if (s >= 120) finishRec(true);        // 2 minutes is the longest voice message
  }, 250);
}
async function finishRec(send) {
  const r = rec; if (!r) return;
  rec = null; clearInterval(r.timer);
  const stopped = new Promise((res) => (r.mr.onstop = res));
  try { r.mr.stop(); } catch (e) {}
  await stopped;
  r.stream.getTracks().forEach((t) => t.stop());
  $("#recbar").hidden = true; $("#composer").hidden = false;
  if (!send) return;
  const dur = Math.max(1, Math.round((Date.now() - r.t0) / 1000));
  if (dur < 1 || !r.chunks.length) return;
  const audio = await blobToDataUrl(new Blob(r.chunks, {type: r.mr.mimeType || "audio/webm"}));
  if (audio.length > MAX_MEDIA * 1.3) return toast("That voice message is too long to send.");
  sendMessage({type: "voice", audio, dur}, "🎤 Voice message (" + fmt(dur) + ")");
}
$("#mic").addEventListener("click", startRec);
$("#recSend").addEventListener("click", () => finishRec(true));
$("#recCancel").addEventListener("click", () => finishRec(false));

let au = null, auId = null;
function playVoice(id) {
  const m = msgs.find((x) => x.id === id);
  if (!m || !m.audio) return;
  if (au && auId === id) { au.paused ? au.play().catch(() => {}) : au.pause(); return; }
  if (au) au.pause();
  au = new Audio(mediaUrl(m, "audio")); auId = id;
  const mine = au;
  au.addEventListener("timeupdate", paintVoice); au.addEventListener("play", paintVoice); au.addEventListener("pause", paintVoice);
  au.addEventListener("ended", () => { if (au === mine) { au = null; auId = null; } paintVoice(); });
  au.play().catch(() => toast("Could not play this voice message."));
}
function paintVoice() {
  document.querySelectorAll(".vm").forEach((el) => {
    const m = msgs.find((x) => x.id === el.dataset.id), on = au && auId === el.dataset.id;
    el.querySelector(".vp").textContent = on && !au.paused ? "❚❚" : "▶";
    const total = (m && m.dur) || (on && isFinite(au.duration) ? au.duration : 0) || 1;
    el.querySelector(".vbar i").style.width = on ? Math.min(100, (au.currentTime / total) * 100) + "%" : "0%";
    el.querySelector(".vd").textContent = on && !au.paused ? fmt(au.currentTime) : fmt((m && m.dur) || 0);
  });
}

/* ---------- read receipts ---------- */
function markRead() {
  if (!cur || !unlocked || document.hidden) return;
  const last = msgs[msgs.length - 1];
  const need = (cur.unread && cur.unread[me.uid] > 0) || (last && last.senderId !== me.uid && !last.pending && ms(last.createdAt) > ms(cur.lastRead && cur.lastRead[me.uid]));
  if (mySet().noReceipts) {
    if (cur.unread && cur.unread[me.uid] > 0) updateDoc(doc(db, "chats", cid), {["unread." + me.uid]: 0}).catch(console.error);
    return;
  }
  if (need) updateDoc(doc(db, "chats", cid), {["lastRead." + me.uid]: serverTimestamp(), ["unread." + me.uid]: 0}).catch(console.error);
}

/* ---------- reply / copy / delete ---------- */
function clearReply() { replyTo = null; $("#replybar").hidden = true; }
$("#replyx").addEventListener("click", clearReply);
function actions(id) {
  const m = msgs.find((x) => x.id === id);
  if (!m || m.pending) return;
  const mine = m.senderId === me.uid, s = $("#sheet");
  s.innerHTML = `<div class="box">${m.deleted ? "" : '<button data-a="reply">Reply</button>'}${!m.deleted && (!m.type || m.type === "text" || m.text) ? '<button data-a="copy">Copy</button>' : ""}<button data-a="delme" class="danger">Delete for me</button>${mine && !m.deleted ? '<button data-a="delall" class="danger">Delete for everyone</button>' : ""}<button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    const ref = doc(db, "chats", cid, "messages", m.id);
    if (a === "reply") { replyTo = m; $("#replytxt").textContent = msgPreview(m); $("#replybar").hidden = false; $("#txt").focus(); }
    if (a === "copy") navigator.clipboard && navigator.clipboard.writeText(m.text);
    if (a === "delme") {
      msgs = msgs.filter((x) => x.id !== m.id); renderMsgs();                                       // gone at once
      updateDoc(ref, {deletedFor: arrayUnion(me.uid)}).catch((err) => { console.error(err); toast("Could not delete the message."); });
    }
    if (a === "delall") {
      try {
        await updateDoc(ref, {deleted: true, text: "", img: null, audio: null, replyTo: null});
        if (msgs[msgs.length - 1] && msgs[msgs.length - 1].id === m.id) updateDoc(doc(db, "chats", cid), {lastMessage: "🚫 This message was deleted"});
      } catch (err) { console.error(err); toast("Could not delete the message."); }
    }
  };
}
let lpTimer = null, lpFired = false, lpX = 0, lpY = 0;
const msgsEl = $("#msgs");
msgsEl.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".msg"); if (!el || el.classList.contains("typing")) return;
  lpFired = false; lpX = e.clientX; lpY = e.clientY;
  lpTimer = setTimeout(() => { lpFired = true; actions(el.dataset.id); }, 500);      // long-press works on photos and voice messages too
});
["pointerup", "pointercancel", "pointerleave"].forEach((t) => msgsEl.addEventListener(t, () => clearTimeout(lpTimer)));
msgsEl.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8) clearTimeout(lpTimer); });
msgsEl.addEventListener("contextmenu", (e) => { if (e.target.closest(".msg")) e.preventDefault(); });
msgsEl.addEventListener("click", (e) => {
  if (lpFired) { lpFired = false; return; }
  const vp = e.target.closest(".vp"); if (vp) return playVoice(vp.closest(".vm").dataset.id);
  const im = e.target.closest(".mimg"); if (im) return openViewer(im.src);
  const el = e.target.closest(".msg"); if (!el || el.classList.contains("typing")) return;
  actions(el.dataset.id);
});

/* ---------- GROUPS: group info (members, add, remove, rename, leave) ---------- */
const sysMsg = (text) => addDoc(collection(db, "chats", cid, "messages"), {type: "system", text, senderId: me.uid, createdAt: serverTimestamp(), deleted: false}).catch(console.error);
const wait = (n) => new Promise((r) => setTimeout(r, n));
function showGroupInfo() {
  if (!cur || !cur.isGroup) return;
  const p = $("#info"), members = cur.participants || [], admins = cur.admins || [], iAdmin = admins.includes(me.uid);
  const row = (u) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 4px">${avatar(u, "sm")}<div style="flex:1;min-width:0"><div>${esc(u === me.uid ? "You" : nameOf(u))}</div><small>${admins.includes(u) ? "Group admin" : ""}</small></div>${iAdmin && u !== me.uid ? `<button class="btn ghost danger" data-rm="${esc(u)}" style="width:auto;padding:6px 10px;margin:0">Remove</button>` : ""}</div>`;
  p.innerHTML = `<div class="box">${groupAvatar(cid, cur.name, "big")}<h2>${esc(cur.name || "Group")}</h2><div class="num">${members.length} ${members.length === 1 ? "member" : "members"}</div>
    <div style="text-align:left;max-height:38vh;overflow:auto;margin:10px 0">${members.map(row).join("")}</div>
    ${iAdmin ? '<button class="btn" data-a="add">Add members</button><button class="btn ghost" data-a="rename">Rename group</button>' : ""}
    <button class="btn ghost danger" data-a="leave">Leave group</button><button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = async (e) => {
    const t = e.target, a = t.dataset.a, rm = t.dataset.rm;
    if (!a && !rm) { if (t === p) closeModal(p); return; }
    if (a === "x") return closeModal(p);
    closeModal(p); await wait(250);
    const ref = doc(db, "chats", cid), mem = cur.participants || [], adm = cur.admins || [], myName = nameOf(me.uid);
    try {
      if (rm) {
        if (!(await dialog({title: "Remove " + nameOf(rm) + "?", text: "They will no longer get messages from this group.", ok: "Remove", danger: true}))) return;
        await sysMsg(myName + " removed " + nameOf(rm));
        await updateDoc(ref, {participants: mem.filter((x) => x !== rm), admins: adm.filter((x) => x !== rm)});
      } else if (a === "add") {
        const r = await pickPeople({title: "Add members", ok: "Add", exclude: mem});
        if (!r) return;
        if (mem.length + r.ids.length > 100) return toast("A group can have up to 100 people.");
        const upd = {participants: [...mem, ...r.ids]};
        r.ids.forEach((u) => (upd["joinedAt." + u] = serverTimestamp()));
        await sysMsg(myName + " added " + r.ids.map((u) => nameOf(u)).join(", "));
        await updateDoc(ref, upd);
      } else if (a === "rename") {
        const n = await dialog({title: "Rename group", input: "text", value: cur.name || "", ok: "Save"});
        if (!n || !n.trim()) return;
        await sysMsg(myName + " renamed the group to \"" + n.trim().slice(0, 60) + "\"");
        await updateDoc(ref, {name: n.trim().slice(0, 60)});
      } else if (a === "leave") {
        if (!(await dialog({title: "Leave this group?", text: "You will stop getting its messages.", ok: "Leave", danger: true}))) return;
        const rest = mem.filter((x) => x !== me.uid), wasAdmin = adm.includes(me.uid);
        const upd = {participants: rest};
        if (wasAdmin) { const na = adm.filter((x) => x !== me.uid); upd.admins = na.length || !rest.length ? na : [rest[0]]; }   // never leave a group without an admin
        await sysMsg(myName + " left");
        await updateDoc(ref, upd);
        goHome();
      }
    } catch (err) { console.error(err); toast("That didn't work: " + (err.code || err.message)); }
  };
}

/* ---------- offline banner, relock, start ---------- */
function netBanner() { $("#offline").hidden = navigator.onLine; }
addEventListener("online", netBanner); addEventListener("offline", netBanner); netBanner();
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { stopTyping(); needRelock = isLocked(cid); return; }
  markRead();
  if (!needRelock) return;
  needRelock = false; relock();
  if (!(await askUnlock(true))) goHome();
});
addEventListener("pagehide", stopTyping);

startSession(async () => {
  cid = GROUP ? groupId : chatId(me.uid, peerUid);
  if (isLocked(cid) && !isUnlocked() && !(await askUnlock(true))) return goHome();
  unlocked = true;
  if (GROUP) {
    cur = {id: cid, isGroup: true, participants: [me.uid], admins: [], unread: {}, lastRead: {}, deliveredAt: {}};
    try {
      const s = await getDoc(doc(db, "chats", cid));
      if (!s.exists() || !(s.data().participants || []).includes(me.uid)) { toast("This group isn't available."); return setTimeout(goHome, 1200); }
      cur = {id: cid, ...s.data()};
      (cur.participants || []).forEach(watch);
    } catch (err) {
      console.warn("Group lookup failed:", err);
      if (err.code === "permission-denied") { toast("You are not in this group."); return setTimeout(goHome, 1200); }
    }
    $("#callBtn").style.display = "none";   // no voice calls in groups
  } else {
    watch(peerUid);
    cur = {id: cid, participants: [me.uid, peerUid].sort(), unread: {}, lastRead: {}, deliveredAt: {}};
  }
  initCalls();
  if (isSelf()) $("#callBtn").style.display = "none";   // NEW: you can't call yourself
  renderHead(); renderMsgs(true);
  hooks.chatsChanged();         // in case the chat list has already loaded
});
fitViewport();
