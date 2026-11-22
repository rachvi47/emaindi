// chat.js - one conversation (chat.html?u=<other person's uid>).
import {db, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, orderBy, onSnapshot, serverTimestamp, increment, arrayUnion} from "./fire.js";
import {$, esc, ms, hm, me, chats, people, hooks, watch, chatId, nameOf, avatar, dayLabel, online, hidden, mySet, isTyping,
  encryptText, decryptText, isLocked, isUnlocked, askUnlock, relock, openModal, closeModal, showInfo, startSession,
  dialog, toast, fitViewport, lsFlag, groupAvatar, pickPeople, isBlocked, toggleBlock, visibleChat, peerOf, isStarred, toggleStar, wallOf, setWall, WALLS, isMuted, setMute, onBack} from "./common.js";
import {initCalls, startCall} from "./call.js";
import {deleteDoc, writeBatch, getDocs as getDocsFs} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
// Cloud Storage (videos, files, full-size photos) needs the Firebase Blaze plan. Until you upgrade, leave this false:
// photos are then sent small, inside the message, and videos / files are switched off.
const USE_STORAGE = false;
let storage = null, storageSdk = null;
async function loadStorage() {
  if (!USE_STORAGE) throw new Error("storage-off");
  if (!storageSdk) { storageSdk = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js"); storage = storageSdk.getStorage(); }
  return storageSdk;
}
import {readChatMessages, saveChatMessages} from "./offline.js";

const qs = new URLSearchParams(location.search);
const groupId = qs.get("g"), GROUP = !!groupId;          // GROUP: chat.html?g=<group id>
const peerUid = GROUP ? "" : qs.get("u");
if (!peerUid && !GROUP) location.replace("home.html");
const MAX_MEDIA = 720000;      // a Firestore document must stay under 1 MB, so photos / voice are kept below this size

let cid = "", cur = null, msgs = [], raw = [], replyTo = null, msgUnsub = null, snapSeq = 0, listening = false, unlocked = false, needRelock = false, leaving = false;
const goHome = () => location.replace("home.html");
const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.round(s) % 60).padStart(2, "0");
const msgPreview = (m) => m.deleted ? "🚫 Deleted message" : m.type === "image" ? "📷 " + (m.text || "Photo") : m.type === "voice" ? "🎤 Voice message" : m.type === "video" ? "🎥 Video" : m.type === "file" ? "📎 " + (m.name || "File") : m.type === "poll" ? "📊 " + (m.question || "Poll") : m.type === "location" ? "📍 Location" : m.type === "contact" ? "👤 " + (m.name || "Contact") : m.type === "call" ? "📞 " + m.text : m.text;
const isSelf = () => !GROUP && !!me && peerUid === me.uid;   // NEW: a chat with yourself ("Message yourself")

/* ---------- header ---------- */
// GROUP permissions
const gAdmin = () => !!cur && (cur.admins || []).includes(me.uid);
const canPost = () => !GROUP || !cur || cur.onlyAdminsPost !== true || gAdmin();
const canEdit = () => gAdmin() || (!!cur && cur.membersCanEdit === true);
const canAddPeople = () => gAdmin() || (!!cur && cur.membersCanAdd === true);
function applyComposer() {   // read-only notice instead of the message box (admins-only groups, blocked contacts)
  const blocked = !GROUP && !isSelf() && isBlocked(peerUid), ok = GROUP ? canPost() : !blocked, bar = $("#composer");
  bar.style.display = ok ? "" : "none";
  let n = $("#roNote");
  if (!ok && !n) { n = document.createElement("div"); n.id = "roNote"; n.style.cssText = "padding:14px;text-align:center;opacity:.75;font-size:14px"; bar.after(n); }
  if (n) {
    n.hidden = ok;
    n.textContent = blocked ? "You blocked this contact. Tap to unblock." : "Only admins can send messages in this group.";
    n.style.cursor = blocked ? "pointer" : "";
    n.onclick = blocked ? () => toggleBlock(peerUid) : null;
  }
}
function renderHead() {
  renderPin(); applyWall();
  const ci = document.getElementById("cinfo"); if (ci && !ci.hidden && !GROUP) renderContactInfo();
  if (GROUP) {
    const names = ((cur && cur.participants) || []).map((u) => (u === me.uid ? "You" : nameOf(u))).join(", ");
    applyComposer();
    const typers = ((cur && cur.participants) || []).filter((u) => u !== me.uid && Date.now() - ms(cur.typing && cur.typing[u]) < 5000);
    const typingLine = typers.length ? esc(typers.slice(0, 2).map((u) => nameOf(u)).join(" and ")) + (typers.length > 2 ? " and others" : "") + (typers.length === 1 ? " is" : " are") + " typing…" : "";
    clearTimeout(typingT); if (typers.length) typingT = setTimeout(renderHead, 5200);
    $("#peer").innerHTML = `${groupAvatar(cid, cur && cur.name, "sm", cur && cur.photo)}<div style="min-width:0"><div class="nm">${esc((cur && cur.name) || "Group")}${cur && cur.ttl > 0 ? " ⏳" : ""}</div><small style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${typingLine || esc(names)}</small></div>`;
    return;
  }
  applyComposer();
  const u = people[peerUid] || {}, self = isSelf();
  // CHANGED: in a chat with yourself there is no online / typing / last seen status
  const st = self ? "Message yourself" : isTyping(cur) ? '<span class="typing-txt">typing<span class="tdots"><i></i><i></i><i></i></span></span>' : hidden(u) ? "" : online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
  $("#peer").innerHTML = `${avatar(peerUid, "sm")}<div style="min-width:0"><div class="nm">${esc(nameOf(peerUid))}${self ? " (You)" : ""}${cur && cur.ttl > 0 ? " ⏳" : ""}</div><small>${st}</small></div>`;
}
$("#peer").addEventListener("click", () => (GROUP ? showGroupInfo() : showContactInfo()));
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
  else if (GROUP && seenInList) { if (!leaving) { toast("This group was deleted, or you were removed from it."); setTimeout(goHome, 1200); } return; }   // GROUP: deleted or removed
  if (!listening) { listening = true; begin(!!c || GROUP); }   // a group is never created from here
  renderHead(); renderMsgs(); markRead();
};
// hides: messages you deleted for yourself, messages from before you deleted the chat, and (groups) messages from before you joined
const visibleMsg = (m) => !(m.deletedFor || []).includes(me.uid)
  && ms(m.createdAt) > ms(cur && cur.deletedAt && cur.deletedAt[me.uid])
  && ms(m.createdAt) >= ms(cur && cur.joinedAt && cur.joinedAt[me.uid])
  && !isExpired(m);
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
    const all = s.docs.map((d) => ({id: d.id, pending: d.metadata.hasPendingWrites && d.data().createdAt == null, ...d.data({serverTimestamps: "estimate"})}));
    purgeExpired(all);
    raw = all.filter(visibleMsg);
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
  const cap = m.text ? `<div class="t">${withMentions(m)}</div>` : "";
  if (m.type === "poll") return pollHtml(m);
  if (m.type === "location") return `<div class="mloc" data-lat="${esc(m.lat)}" data-lng="${esc(m.lng)}" style="min-width:210px;cursor:pointer"><div style="height:84px;border-radius:10px;background:linear-gradient(135deg,#cfe8d5,#bcd9f0);display:grid;place-items:center;font-size:34px">📍</div><div style="font-weight:700;margin-top:6px">Location</div><small style="opacity:.7">${Number(m.lat).toFixed(5)}, ${Number(m.lng).toFixed(5)}${m.acc ? " · ±" + esc(m.acc) + " m" : ""}</small><div style="font-size:13px;color:#2f8fd6;margin-top:2px">Open in Maps</div></div>`;
  if (m.type === "contact") return `<div class="mct" data-uid="${esc(m.uid || "")}" style="display:flex;align-items:center;gap:10px;min-width:210px;cursor:pointer">${m.uid ? avatar(m.uid, "sm") : ""}<div style="min-width:0"><div style="font-weight:700">${esc(m.name || "Contact")}</div><small style="opacity:.7">${esc(m.phone || m.email || "")}</small><div style="font-size:13px;color:#2f8fd6">Message</div></div></div>`;
  if (m.type === "image" && m.img) return `<img class="mimg" src="${mediaUrl(m, "img")}" ${m.url ? `data-full="${esc(m.url)}"` : ""} alt="Photo" loading="lazy" decoding="async">${cap}`;
  if (m.type === "video") return `<div class="mvf" data-video="${esc(m.url || "")}" style="position:relative;display:inline-block;cursor:pointer;border-radius:10px;overflow:hidden;max-width:100%">${m.img ? `<img class="mimg" style="pointer-events:none;display:block" src="${mediaUrl(m, "img")}" alt="Video">` : '<div style="width:220px;height:140px;background:#1b2437"></div>'}<span style="position:absolute;inset:0;display:grid;place-items:center;font-size:40px;color:#fff;text-shadow:0 1px 8px rgba(0,0,0,.6)">▶</span>${m.dur ? `<span style="position:absolute;left:8px;bottom:6px;color:#fff;font-size:12px;text-shadow:0 1px 4px rgba(0,0,0,.7)">🎥 ${fmt(m.dur)}</span>` : ""}</div>${cap}`;
  if (m.type === "file") return `<div class="mfile" data-url="${esc(m.url || "")}" data-name="${esc(m.name || "file")}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.16);cursor:pointer;min-width:200px"><span style="font-size:28px">📄</span><div style="min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name || "File")}</div><small style="opacity:.7">${m.size ? fmtSize(m.size) : ""}</small></div></div>`;
  if (m.type === "voice" && m.audio) return `<div class="vm" data-id="${m.id}"><button class="vp" aria-label="Play">▶</button><div class="vbar"><i></i></div><span class="vd">${fmt(m.dur || 0)}</span></div>`;
  return `<div class="t">${withMentions(m)}</div>${linkCard(m)}`;
}
const FWD = '<div style="font-size:11px;opacity:.65;font-style:italic;margin-bottom:2px">↪ Forwarded</div>';
function linkEsc(t) {   // web addresses become tappable links
  let out = "", last = 0;
  t.replace(/https?:\/\/[^\s<>"']*[^\s<>"'.,!?;:)\]]/g, (u, i) => {
    out += esc(t.slice(last, i)) + `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" style="color:#2f8fd6;text-decoration:underline;word-break:break-all">${esc(u)}</a>`;
    last = i + u.length; return u;
  });
  return out + esc(t.slice(last));
}
function linkCard(m) {   // a small card with the website name for the first link
  const um = /https?:\/\/[^\s<>"']+/.exec(m.text || ""); if (!um) return "";
  let host = "", rest = "";
  try { const u = new URL(um[0]); host = u.hostname.replace(/^www\./, ""); rest = (u.pathname + u.search).replace(/^\/$/, ""); } catch (e) { return ""; }
  return `<div class="mlink" data-url="${esc(um[0])}" style="margin-top:6px;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.16);cursor:pointer"><small style="opacity:.7">🔗 ${esc(host)}</small><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${esc(rest || um[0])}</div></div>`;
}
function pollHtml(m) {
  const votes = m.votes || {}, mine = votes[me.uid] || [], total = Object.keys(votes).filter((u) => (votes[u] || []).length).length;
  const rows = (m.options || []).map((o, i) => {
    const n = Object.values(votes).filter((v) => (v || []).includes(i)).length, pct = total ? Math.round((100 * n) / total) : 0, on = mine.includes(i);
    return `<button data-poll="${i}" style="position:relative;display:block;width:100%;text-align:left;margin-top:6px;padding:8px 10px;border-radius:10px;border:1.5px solid ${on ? "#34B7F1" : "rgba(128,128,128,.35)"};overflow:hidden;background:none;color:inherit"><span style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:rgba(52,183,241,.22)"></span><span style="position:relative;display:flex;justify-content:space-between;gap:10px"><span>${on ? "✓ " : ""}${esc(o)}</span><b>${n}</b></span></button>`;
  }).join("");
  return `<div style="min-width:220px"><div style="font-weight:700">📊 ${esc(m.question || "Poll")}</div><small style="opacity:.65">${m.multi ? "Select one or more" : "Select one"}</small>${rows}<small style="opacity:.65;display:block;margin-top:6px">${total} ${total === 1 ? "vote" : "votes"}</small></div>`;
}
function withMentions(m) {   // @Name inside a message is shown in bold blue
  let out = linkEsc(m.text || "");
  for (const x of m.mentions || []) { const k = esc("@" + x.n); out = out.split(k).join(`<b style="color:#2f8fd6">${k}</b>`); }
  return out;
}
function rxHtml(m) {   // emoji reactions under a message
  if (m.deleted || !m.reactions) return "";
  const cnt = {}; for (const e of Object.values(m.reactions)) if (e) cnt[e] = (cnt[e] || 0) + 1;
  const keys = Object.keys(cnt); if (!keys.length) return "";
  const mineE = m.reactions[me.uid];
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${keys.map((e) => `<span style="background:rgba(128,128,128,.2);border-radius:10px;padding:1px 7px;font-size:13px;${e === mineE ? "outline:1.5px solid #34B7F1;" : ""}">${esc(e)}${cnt[e] > 1 ? " " + cnt[e] : ""}</span>`).join("")}</div>`;
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
    h += `<div class="msg ${mine ? "me" : ""} ${m.deleted ? "del" : ""}" data-id="${m.id}">${senderTag(m, mine)}${m.fwd && !m.deleted ? FWD : ""}${m.deleted ? "" : q}${bodyHtml(m)}${rxHtml(m)}<div class="ft">${m.edited && !m.deleted ? "<i>edited</i> " : ""}${isStarred(cid, m.id) ? "⭐ " : ""}${hm(t)} ${mine ? tick(m) : ""}</div></div>`;
  }
  if (isTyping(cur) && !isSelf()) h += '<div class="msg typing"><i></i><i></i><i></i></div>';
  box.innerHTML = h;
  paintVoice();
  if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------- sending ---------- */
async function sendMessage(fields, previewText) {
  if (!cid) return false;
  if (GROUP && !canPost()) { toast("Only admins can send messages in this group."); return false; }
  if (!GROUP && !isSelf() && isBlocked(peerUid)) { toast("You blocked this contact. Unblock to send messages."); return false; }
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
  const ment = GROUP && fields.text ? mentions.filter((x) => fields.text.includes("@" + x.n)) : [];   // @mentions still present in the text
  mentions = [];
  const fail = (err) => { console.error(err); toast("Message could not be sent."); };
  // not awaited on purpose: offline, these wait in the phone's queue and go out when the internet returns
  addDoc(collection(db, "chats", cid, "messages"), {senderId: me.uid, createdAt: serverTimestamp(), replyTo: rep, deleted: false, ...fields, ...(ment.length ? {mentions: ment} : {}), text}).catch(fail);
  // CHANGED: a message to yourself is never "unread"
  const chatUpdate = {lastMessage: last, lastMessageAt: serverTimestamp(), lastSender: me.uid};
  if (GROUP) chatUpdate.lastMentions = ment.map((x) => x.u);   // lets muted people still be alerted
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
  if (!cid || isSelf()) return;      // nobody to show "typing…" to in a chat with yourself
  if (on) { if (Date.now() - typingSentAt < 2500) return; typingSentAt = Date.now(); typingOn = true; }
  else { if (!typingOn) return; typingOn = false; typingSentAt = 0; }
  updateDoc(doc(db, "chats", cid), {["typing." + me.uid]: on ? serverTimestamp() : 0}).catch(() => {});
}
const stopTyping = () => sendTyping(false);
$("#txt").addEventListener("input", () => { grow(); updateSendMic(); $("#txt").value.trim() ? sendTyping(true) : stopTyping(); });
$("#txt").addEventListener("blur", stopTyping);

/* ---------- photos ---------- */
function compressImage(file, maxSide = 1280, limit = MAX_MEDIA) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      let scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      for (let round = 0; round < 4; round++) {
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        for (let q = 0.78; q >= 0.4; q -= 0.12) {
          const out = c.toDataURL("image/jpeg", q);
          if (out.length <= limit) return resolve({data: out, w, h});
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
$("#attach").addEventListener("click", attachMenu);
/* ---------- attachments: photos (and, with Cloud Storage switched on, videos and files) ---------- */
const MAX_VIDEO = 20 * 1024 * 1024, MAX_FILE = 15 * 1024 * 1024;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const randId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const extOf = (name) => { const m = /\.[A-Za-z0-9]{1,8}$/.exec(name || ""); return m ? m[0].toLowerCase() : ""; };

function uploadUi(label, task) {   // small progress bar with a Cancel button
  let el = document.getElementById("upl");
  if (!el) {
    el = document.createElement("div"); el.id = "upl";
    el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);top:max(64px,calc(env(safe-area-inset-top) + 56px));z-index:30;background:#14213D;color:#fff;border-radius:14px;padding:10px 14px;display:flex;align-items:center;gap:14px;box-shadow:0 6px 20px rgba(0,0,0,.3);font-size:14px;max-width:92%";
    document.body.appendChild(el);
  }
  el.innerHTML = `<span id="uplt">${esc(label)}…</span><button id="uplx" style="color:#FFC93C;font-weight:700">Cancel</button>`;
  el.querySelector("#uplx").onclick = () => task.cancel();
  return {progress: (p) => { const t = document.getElementById("uplt"); if (t) t.textContent = label + " " + Math.round(p) + "%"; }, close: () => el.remove()};
}
async function uploadToStorage(blob, name, contentType, label) {
  const path = `chats/${cid}/${me.uid}/${randId()}${extOf(name)}`;
  const S = await loadStorage();
  const task = S.uploadBytesResumable(S.ref(storage, path), blob, {contentType: contentType || "application/octet-stream", cacheControl: "private, max-age=31536000"});
  const ui = uploadUi(label, task);
  try {
    await new Promise((res, rej) => task.on("state_changed", (s) => ui.progress((100 * s.bytesTransferred) / s.totalBytes), rej, res));
    return {url: await S.getDownloadURL(task.snapshot.ref), path};
  } finally { ui.close(); }
}
const wasCancelled = (err) => !!err && err.code === "storage/canceled";

const INLINE_PHOTO = 260000;   // about 190 KB per photo, so your free database space lasts much longer
async function sendPhoto(f) {
  if (!USE_STORAGE) {
    let img;
    try { img = await compressImage(f, 1024, INLINE_PHOTO); } catch (e) { return toast("Could not read that photo. Try a JPEG or PNG."); }
    if (!img) return toast("That photo is too large to send.");
    const c = await previewImage(img.data);
    if (c === null) return;
    return sendMessage({type: "image", img: img.data, w: img.w, h: img.h, text: c}, "📷 " + (c || "Photo"));
  }
  let full, thumb;
  try { full = await compressImage(f, 1600, 3000000); thumb = await compressImage(f, 320, 40000); } catch (e) { return toast("Could not read that photo. Try a JPEG or PNG."); }
  if (!full || !thumb) return toast("That photo is too large to send.");
  const cap = await previewImage(full.data);
  if (cap === null) return;
  let up = null;
  try { up = await uploadToStorage(dataUrlToBlob(full.data), "photo.jpg", "image/jpeg", "Sending photo"); }
  catch (err) { if (wasCancelled(err)) return toast("Cancelled."); console.warn("Cloud Storage upload failed, sending the photo inside the message instead:", err); }
  if (up) return sendMessage({type: "image", img: thumb.data, url: up.url, path: up.path, w: full.w, h: full.h, size: Math.round(full.data.length * 0.75), text: cap}, "📷 " + (cap || "Photo"));
  const small = await compressImage(f, 1280, MAX_MEDIA);   // fallback: a smaller photo saved inside the message
  if (!small) return toast("That photo is too large to send.");
  sendMessage({type: "image", img: small.data, w: small.w, h: small.h, text: cap}, "📷 " + (cap || "Photo"));
}

function videoMeta(file) {   // first frame as a small preview picture + length
  return new Promise((res) => {
    const v = document.createElement("video"), u = URL.createObjectURL(file);
    let done = false;
    const fin = (o) => { if (done) return; done = true; URL.revokeObjectURL(u); res(o); };
    const none = () => ({poster: "", dur: Math.round(v.duration || 0) || 0, w: v.videoWidth || 0, h: v.videoHeight || 0});
    v.preload = "metadata"; v.muted = true; v.playsInline = true;
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (e) { fin(none()); } };
    v.onseeked = () => {
      try {
        const s = 320 / Math.max(v.videoWidth, v.videoHeight, 1), c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * s)); c.height = Math.max(1, Math.round(v.videoHeight * s));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        let poster = c.toDataURL("image/jpeg", 0.6); if (poster.length > 40000) poster = c.toDataURL("image/jpeg", 0.4); if (poster.length > 60000) poster = "";
        fin({poster, dur: Math.round(v.duration || 0) || 0, w: v.videoWidth, h: v.videoHeight});
      } catch (e) { fin(none()); }
    };
    v.onerror = () => fin(none());
    setTimeout(() => fin(none()), 6000);
    v.src = u;
  });
}
async function sendVideo(f) {
  if (f.size > MAX_VIDEO) return toast("Videos can be up to " + fmtSize(MAX_VIDEO) + ". Trim or compress it first.");
  if (!(await dialog({title: "Send video?", text: (f.name || "Video") + " · " + fmtSize(f.size), ok: "Send"}))) return;
  const meta = await videoMeta(f);
  try {
    const up = await uploadToStorage(f, f.name, f.type || "video/mp4", "Sending video");
    sendMessage({type: "video", img: meta.poster || null, url: up.url, path: up.path, dur: meta.dur, w: meta.w, h: meta.h, size: f.size, mime: f.type || "", text: ""}, "🎥 Video");
  } catch (err) { if (wasCancelled(err)) return toast("Cancelled."); console.error(err); toast("Could not send the video. Cloud Storage may not be switched on yet."); }
}
async function sendDocument(f) {
  if (f.size > MAX_FILE) return toast("Files can be up to " + fmtSize(MAX_FILE) + ".");
  if (/\.(exe|bat|cmd|msi|apk|scr|vbs|ps1|jar|com|js)$/i.test(f.name)) return toast("This type of file can't be sent.");
  if (!(await dialog({title: "Send file?", text: f.name + " · " + fmtSize(f.size), ok: "Send"}))) return;
  try {
    const up = await uploadToStorage(f, f.name, f.type, "Sending file");
    sendMessage({type: "file", url: up.url, path: up.path, name: f.name.slice(0, 120), size: f.size, mime: f.type || "", text: ""}, "📎 " + f.name.slice(0, 60));
  } catch (err) { if (wasCancelled(err)) return toast("Cancelled."); console.error(err); toast("Could not send the file. Cloud Storage may not be switched on yet."); }
}
$("#file").addEventListener("change", async () => {
  const f = $("#file").files[0]; $("#file").value = "";
  if (!f || !cid) return;
  if (GROUP && !canPost()) return toast("Only admins can send messages in this group.");
  if (!GROUP && !isSelf() && isBlocked(peerUid)) return toast("You blocked this contact. Unblock to send messages.");
  if (f.type.startsWith("image/")) return sendPhoto(f);
  if (!USE_STORAGE) return toast("Only photos can be sent for now. Videos and files need Cloud Storage.");
  if (f.type.startsWith("video/")) return sendVideo(f);
  return sendDocument(f);
});
$("#file").accept = USE_STORAGE ? "image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip" : "image/*";
function openViewer(src, fallback) {
  const v = $("#viewer"), i = v.querySelector("img");
  i.hidden = false;
  i.onerror = () => {
    if (fallback && i.src !== fallback) { i.onerror = null; i.src = fallback; toast("Showing a small preview. The full photo is no longer stored."); }
    else toast("This photo is no longer available.");
  };
  i.src = src; openModal(v);
}
function openVideo(url) {
  if (!url) return toast("This video is no longer available.");
  const v = $("#viewer"), i = v.querySelector("img");
  i.hidden = true;
  const old = v.querySelector("video"); if (old) old.remove();
  const vd = document.createElement("video");
  vd.src = url; vd.controls = true; vd.autoplay = true; vd.playsInline = true;
  vd.style.cssText = "max-width:100%;max-height:100%;margin:auto;display:block";
  vd.onerror = () => { toast("This video is no longer available."); closeModal(v); };
  v.appendChild(vd); openModal(v);
}
function openFile(url, name) {
  if (!url) return toast("This file is no longer available.");
  const a = document.createElement("a");
  a.href = url; a.target = "_blank"; a.rel = "noopener"; a.download = name || "";
  document.body.appendChild(a); a.click(); a.remove();
}
new MutationObserver(() => {   // stop and remove the video when the viewer closes
  const v = $("#viewer");
  if (v.hidden) { const vd = v.querySelector("video"); if (vd) { vd.pause(); vd.remove(); } v.querySelector("img").hidden = false; }
}).observe($("#viewer"), {attributes: true, attributeFilter: ["hidden"]});
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
  const textual = !m.type || m.type === "text";
  const canEditMsg = mine && !m.deleted && textual && Date.now() - ms(m.createdAt) < 30 * 60e3;   // edit within 30 minutes
  const rxRow = m.deleted ? "" : `<div style="display:flex;justify-content:space-around;padding:8px 4px 6px">${["👍", "❤️", "😂", "😮", "😢", "🙏"].map((e) => `<button data-r="${e}" style="width:auto;padding:6px 8px;font-size:24px;border-radius:50%;${(m.reactions || {})[me.uid] === e ? "background:rgba(52,183,241,.28);" : ""}">${e}</button>`).join("")}</div>`;
  s.innerHTML = `<div class="box" style="max-height:88vh;overflow-y:auto">${rxRow}${m.deleted ? "" : '<button data-a="reply">Reply</button>'}${!m.deleted && (!m.type || m.type === "text" || m.text) ? '<button data-a="copy">Copy</button>' : ""}${!m.deleted && m.type !== "poll" ? '<button data-a="fwd">Forward</button>' : ""}${!m.deleted ? `<button data-a="star">${isStarred(cid, m.id) ? "⭐ Unstar" : "⭐ Star"}</button>` : ""}${!m.deleted && canPin() ? `<button data-a="pin">${cur && cur.pinned && cur.pinned.id === m.id ? "📌 Unpin" : "📌 Pin to top"}</button>` : ""}${mine && !m.deleted ? '<button data-a="info">ℹ️ Message info</button>' : ""}${canEditMsg ? '<button data-a="edit">Edit</button>' : ""}<button data-a="delme" class="danger">Delete for me</button>${mine && !m.deleted ? '<button data-a="delall" class="danger">Delete for everyone</button>' : ""}<button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a, rx = ev.target.dataset.r;
    if (!a && !rx && ev.target !== s) return;
    closeModal(s);
    const ref = doc(db, "chats", cid, "messages", m.id);
    if (rx) {   // tap the same emoji again to remove it
      updateDoc(ref, {["reactions." + me.uid]: (m.reactions || {})[me.uid] === rx ? "" : rx}).catch((err) => { console.error(err); toast("Could not add the reaction."); });
      return;
    }
    if (a === "fwd") { await wait(250); return forwardMessage(m); }
    if (a === "edit") { await wait(250); return editMessage(m, ref); }
    if (a === "star") { toggleStar(cid, m.id).then((ok) => ok && toast(isStarred(cid, m.id) ? "Message starred." : "Star removed.")); return; }
    if (a === "pin") return pinMsg(m);
    if (a === "info") { await wait(250); return showMsgInfo(m); }
    if (a === "reply") { startReply(m); }
    if (a === "copy") navigator.clipboard && navigator.clipboard.writeText(m.text);
    if (a === "delme") {
      msgs = msgs.filter((x) => x.id !== m.id); renderMsgs();                                       // gone at once
      updateDoc(ref, {deletedFor: arrayUnion(me.uid)}).catch((err) => { console.error(err); toast("Could not delete the message."); });
    }
    if (a === "delall") {
      try {
        await updateDoc(ref, {deleted: true, text: "", img: null, audio: null, replyTo: null, url: null, path: null});
        if (m.path && USE_STORAGE) loadStorage().then((S) => S.deleteObject(S.ref(storage, m.path))).catch(() => {});   // frees the space in Cloud Storage
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
  const po = e.target.closest("[data-poll]"); if (po) return votePoll(po.closest(".msg").dataset.id, +po.dataset.poll);
  const lc = e.target.closest(".mloc"); if (lc) return window.open("https://www.google.com/maps?q=" + encodeURIComponent(lc.dataset.lat + "," + lc.dataset.lng), "_blank", "noopener");
  const ct = e.target.closest(".mct"); if (ct) { if (ct.dataset.uid && ct.dataset.uid !== me.uid) location.href = "chat.html?u=" + encodeURIComponent(ct.dataset.uid); return; }
  const lk = e.target.closest(".mlink"); if (lk) return window.open(lk.dataset.url, "_blank", "noopener");
  const vf = e.target.closest("[data-video]"); if (vf) return openVideo(vf.dataset.video);
  const fl = e.target.closest(".mfile"); if (fl) return openFile(fl.dataset.url, fl.dataset.name);
  const im = e.target.closest(".mimg"); if (im) return openViewer(im.dataset.full || im.src, im.src);
  const el = e.target.closest(".msg"); if (!el || el.classList.contains("typing")) return;
  actions(el.dataset.id);
});

/* ---------- edit, forward, search in chat, @mentions ---------- */
async function editMessage(m, ref) {
  const t = await dialog({title: "Edit message", input: "textarea", value: m.text || "", ok: "Save"});
  if (t === null) return;
  const nt = t.trim();
  if (!nt || nt === (m.text || "")) return;
  try {
    await updateDoc(ref, {text: await encryptText(peerUid, nt), edited: true, editedAt: serverTimestamp()});
    if (msgs[msgs.length - 1] && msgs[msgs.length - 1].id === m.id) updateDoc(doc(db, "chats", cid), {lastMessage: await encryptText(peerUid, nt.slice(0, 200))}).catch(() => {});
  } catch (err) { console.error(err); toast("Could not edit the message (edits are allowed for 30 minutes)."); }
}

// choose which chats to forward to
function pickChats() {
  return new Promise((res) => {
    const list = chats.filter((c) => visibleChat(c) && !isLocked(c.id));
    const nm = (c) => (c.isGroup ? c.name || "Group" : nameOf(peerOf(c)) + (peerOf(c) === me.uid ? " (You)" : ""));
    const rows = list.length ? list.map((c) => `<label style="display:flex;align-items:center;gap:10px;padding:8px 2px;cursor:pointer"><input type="checkbox" value="${esc(c.id)}" style="width:18px;height:18px;flex:none">${c.isGroup ? groupAvatar(c.id, c.name, "sm", c.photo) : avatar(peerOf(c), "sm")}<span style="min-width:0">${esc(nm(c))}</span></label>`).join("") : '<p style="opacity:.7">You have no other chats yet.</p>';
    const d = $("#dlg");
    d.innerHTML = `<div class="dbox"><h3>Forward to…</h3><div style="max-height:45vh;overflow:auto;text-align:left;margin:8px 0">${rows}</div><div class="dact"><button data-a="c">Cancel</button><button data-a="o">Send</button></div></div>`;
    d.hidden = false;
    const done = (v) => { d.hidden = true; d.onclick = null; res(v); };
    d.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === "o") {
        const ids = [...d.querySelectorAll('input[type="checkbox"]:checked')].map((x) => x.value);
        if (!ids.length) return toast("Select at least one chat.");
        done(list.filter((c) => ids.includes(c.id)));
      } else if (a === "c" || e.target === d) done(null);
    };
  });
}
// writes one forwarded message into any chat; returns "" on success or the reason it was skipped
async function postTo(c, m) {
  const g = c.isGroup === true, peer = g ? "" : (c.participants || []).find((u) => u !== me.uid) || me.uid, self = !g && peer === me.uid;
  if (g && c.onlyAdminsPost === true && !(c.admins || []).includes(me.uid)) return "only admins can send in " + (c.name || "that group");
  if (!g && !self && isBlocked(peer)) return "you blocked " + nameOf(peer);
  const media = {url: m.url || null, w: m.w || null, h: m.h || null, size: m.size || null};
  const fields = m.type === "image" ? {type: "image", img: m.img, ...media, text: m.text ? await encryptText(peer, m.text) : ""}
    : m.type === "video" ? {type: "video", img: m.img || null, dur: m.dur || 0, mime: m.mime || "", ...media, text: ""}
    : m.type === "file" ? {type: "file", name: m.name || "file", mime: m.mime || "", ...media, text: ""}
    : m.type === "location" ? {type: "location", lat: m.lat, lng: m.lng, acc: m.acc || 0, text: ""}
    : m.type === "contact" ? {type: "contact", uid: m.uid || null, name: m.name || "", phone: m.phone || "", email: m.email || "", text: ""}
    : m.type === "voice" ? {type: "voice", audio: m.audio, dur: m.dur || 0, text: ""}
    : {text: await encryptText(peer, m.text || "")};
  const last = await encryptText(peer, msgPreview(m).slice(0, 200));
  addDoc(collection(db, "chats", c.id, "messages"), {senderId: me.uid, createdAt: serverTimestamp(), replyTo: null, deleted: false, fwd: true, ...fields}).catch(console.error);
  const upd = {lastMessage: last, lastMessageAt: serverTimestamp(), lastSender: me.uid};
  if (g) { upd.lastMentions = []; (c.participants || []).filter((u) => u !== me.uid).forEach((u) => (upd["unread." + u] = increment(1))); }
  else if (!self) upd["unread." + peer] = increment(1);
  updateDoc(doc(db, "chats", c.id), upd).catch(console.error);
  return "";
}
async function forwardMessage(m) {
  const targets = await pickChats();
  if (!targets || !targets.length) return;
  let ok = 0; const skipped = [];
  for (const c of targets) { try { const why = await postTo(c, m); why ? skipped.push(why) : ok++; } catch (err) { console.error(err); skipped.push("an error"); } }
  toast(ok ? "Forwarded to " + ok + (ok === 1 ? " chat." : " chats.") + (skipped.length ? " Skipped: " + skipped.join(", ") + "." : "") : "Not forwarded: " + skipped.join(", ") + ".");
}

// search inside this chat (looks through every message loaded in the chat)
function openFind() {
  if (document.getElementById("find")) return;
  const p = document.createElement("div");
  p.id = "find";
  p.style.cssText = "position:fixed;inset:0;z-index:12;background:var(--paper);display:flex;flex-direction:column";
  p.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));background:#14213D"><button id="fx" aria-label="Close search" style="color:#fff;font-size:22px;width:36px;height:36px">&#8592;</button><input id="fq" type="search" placeholder="Search in this chat" autocomplete="off" style="flex:1;border:0;border-radius:20px;padding:9px 14px;outline:0;color:#14213D;background:#fff"></div><div id="fres" style="flex:1;overflow:auto"></div>`;
  document.body.appendChild(p);
  const fq = p.querySelector("#fq"), res = p.querySelector("#fres");
  const close = () => p.remove();
  const hl = (s, q) => { const i = s.toLowerCase().indexOf(q); if (i < 0) return esc(s.slice(0, 120)); const a = Math.max(0, i - 30); return (a ? "…" : "") + esc(s.slice(a, i)) + '<mark style="background:#FFC93C;color:#14213D;border-radius:3px">' + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length, i + q.length + 80)); };
  const run = () => {
    const q = fq.value.trim().toLowerCase();
    if (!q) { res.innerHTML = '<p style="text-align:center;opacity:.6;padding:24px">Type a word to search this chat.</p>'; return; }
    const hits = msgs.filter((m) => !m.deleted && m.type !== "call" && m.type !== "system" && (m.text || "").toLowerCase().includes(q)).reverse().slice(0, 100);
    res.innerHTML = hits.length ? hits.map((m) => `<button data-id="${m.id}" style="display:block;width:100%;text-align:left;padding:12px 16px;border-bottom:1px solid var(--line)"><small style="opacity:.65">${esc(m.senderId === me.uid ? "You" : nameOf(m.senderId))} · ${esc(dayLabel(ms(m.createdAt)))} ${hm(ms(m.createdAt))}</small><div>${hl(m.text, q)}</div></button>`).join("") : '<p style="text-align:center;opacity:.6;padding:24px">No messages found.</p>';
  };
  fq.addEventListener("input", run);
  p.querySelector("#fx").addEventListener("click", close);
  res.addEventListener("click", (e) => {
    const b = e.target.closest("[data-id]"); if (!b) return;
    close();
    const el = $("#msgs").querySelector('.msg[data-id="' + b.dataset.id + '"]');
    if (el) { el.scrollIntoView({block: "center"}); const old = el.style.background; el.style.transition = "background .3s"; el.style.background = "rgba(255,201,60,.6)"; setTimeout(() => (el.style.background = old), 1700); }
  });
  run(); fq.focus();
}
$("#findBtn").addEventListener("click", openFind);

// @mentions: typing @ in a group shows the members to pick from
let mentions = [];
function mentionCheck() {
  const box = $("#mbox");
  if (!GROUP || !cur) { box.hidden = true; return; }
  const t = $("#txt"), before = t.value.slice(0, t.selectionStart), m = before.match(/(^|\s)@([^\s@]{0,20})$/);
  if (!m) { box.hidden = true; return; }
  const q = m[2].toLowerCase();
  const cand = (cur.participants || []).filter((u) => u !== me.uid && nameOf(u).toLowerCase().includes(q)).slice(0, 6);
  if (!cand.length) { box.hidden = true; return; }
  box.innerHTML = cand.map((u) => `<button data-u="${esc(u)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 14px;text-align:left">${avatar(u, "sm")}<span>${esc(nameOf(u))}</span></button>`).join("");
  box.hidden = false;
  box.onclick = (e) => {
    const b = e.target.closest("[data-u]"); if (!b) return;
    const u = b.dataset.u, name = nameOf(u), start = before.length - m[2].length - 1;
    t.value = t.value.slice(0, start) + "@" + name + " " + t.value.slice(t.selectionStart);
    const pos = start + name.length + 2; t.setSelectionRange(pos, pos);
    if (!mentions.some((x) => x.u === u)) mentions.push({u, n: name});
    box.hidden = true; t.focus(); grow(); updateSendMic();
  };
}
$("#txt").addEventListener("input", mentionCheck);

// invite link: anyone with the link can join (admins can switch it off)
const inviteUrl = (code) => location.origin + "/join.html?c=" + encodeURIComponent(code);
async function ensureInvite() {
  if (cur.inviteCode) return cur.inviteCode;
  const code = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
  await setDoc(doc(db, "invites", code), {chatId: cid, name: cur.name || "Group", createdBy: me.uid, active: true, createdAt: serverTimestamp()});
  await updateDoc(chatRef(), {inviteCode: code});
  return code;
}
async function inviteDialog() {
  const url = inviteUrl(await ensureInvite());
  const go = await dialog({title: "Group invite link", text: url + "\n\nAnyone with this link can join the group. You can revoke it any time.", ok: "Share link", cancel: "Close"});
  if (!go) return;
  const data = {title: cur.name || "Group", text: "Join my group on emaindi: " + (cur.name || ""), url};
  try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(url); toast("Link copied."); } } catch (e) {}
}
async function revokeInvite() {
  if (!cur.inviteCode) return;
  if (!(await dialog({title: "Revoke invite link?", text: "The old link will stop working. You can make a new one later.", ok: "Revoke", danger: true}))) return;
  await updateDoc(doc(db, "invites", cur.inviteCode), {active: false});
  await updateDoc(chatRef(), {inviteCode: ""});
  toast("Invite link revoked.");
}

/* ---------- GROUPS: group info, settings, roles, photo, delete ---------- */
const sysMsg = (text) => addDoc(collection(db, "chats", cid, "messages"), {type: "system", text, senderId: me.uid, createdAt: serverTimestamp(), deleted: false}).catch(console.error);
const wait = (n) => new Promise((r) => setTimeout(r, n));
const chatRef = () => doc(db, "chats", cid);
const fail = (err) => { console.error(err); toast("That didn't work: " + (err.code || err.message)); };

// choose a picture, crop to a square and shrink to 256px (same as profile pictures)
function pickGroupPhoto() {
  return new Promise((res) => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = "image/*";
    i.onchange = () => {
      const f = i.files[0]; if (!f) return res(null);
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas"); cv.width = cv.height = 256;
        const s = Math.min(img.width, img.height);
        cv.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        URL.revokeObjectURL(img.src); res(cv.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => { toast("That file is not a valid image."); res(null); };
      img.src = URL.createObjectURL(f);
    };
    i.click();
  });
}

function memberMenu(u) {   // admin taps a member: make / remove admin, remove from group
  const s = $("#sheet"), isAdm = (cur.admins || []).includes(u);
  s.innerHTML = `<div class="box"><button data-a="adm">${isAdm ? "Remove as group admin" : "Make group admin"}</button><button data-a="kick" class="danger">Remove from group</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (!a || a === "x") return;
    await wait(250);
    const mem = cur.participants || [], adm = cur.admins || [], who = nameOf(me.uid);
    try {
      if (a === "adm") {
        await sysMsg(isAdm ? `${who} removed ${nameOf(u)} as admin` : `${who} made ${nameOf(u)} an admin`);
        await updateDoc(chatRef(), {admins: isAdm ? adm.filter((x) => x !== u) : [...adm, u]});
      } else if (a === "kick") {
        if (!(await dialog({title: "Remove " + nameOf(u) + "?", text: "They will no longer get messages from this group.", ok: "Remove", danger: true}))) return;
        await sysMsg(`${who} removed ${nameOf(u)}`);
        await updateDoc(chatRef(), {participants: mem.filter((x) => x !== u), admins: adm.filter((x) => x !== u)});
      }
    } catch (err) { fail(err); }
  };
}

async function deleteGroup() {
  if (!navigator.onLine) return toast("You need internet to delete a group.");
  if (!(await dialog({title: "Delete this group?", text: "The group and all its messages will be deleted for everyone. This cannot be undone.", ok: "Delete", danger: true}))) return;
  leaving = true; toast("Deleting group…");
  try {
    const snap = await getDocsFs(collection(db, "chats", cid, "messages"));
    let b = writeBatch(db), n = 0;
    for (const d of snap.docs) { const fp = d.data().path; if (fp && USE_STORAGE) loadStorage().then((S) => S.deleteObject(S.ref(storage, fp))).catch(() => {}); b.delete(d.ref); if (++n % 400 === 0) { await b.commit(); b = writeBatch(db); } }
    await b.commit();
    await deleteDoc(chatRef());
    goHome();
  } catch (err) { leaving = false; fail(err); }
}

function showGroupInfo() {
  if (!cur || !cur.isGroup) return;
  const p = $("#info"), members = cur.participants || [], admins = cur.admins || [], iAdmin = gAdmin(), edit = canEdit();
  const chk = (k, title, sub) => `<label style="display:flex;align-items:center;gap:12px;padding:9px 0;cursor:pointer"><input type="checkbox" data-s="${k}" ${cur[k] ? "checked" : ""} style="width:18px;height:18px;flex:none"><span>${title}<small style="display:block;opacity:.6">${sub}</small></span></label>`;
  const row = (u) => `<div ${iAdmin && u !== me.uid ? `data-m="${esc(u)}"` : ""} style="display:flex;align-items:center;gap:10px;padding:8px 4px;${iAdmin && u !== me.uid ? "cursor:pointer" : ""}">${avatar(u, "sm")}<div style="flex:1;min-width:0;pointer-events:none"><div>${esc(u === me.uid ? "You" : nameOf(u))}</div></div>${admins.includes(u) ? '<small style="pointer-events:none;border:1px solid currentColor;border-radius:6px;padding:1px 6px;opacity:.7">Admin</small>' : ""}</div>`;
  p.innerHTML = `<div class="box">
    <div style="position:relative;display:inline-block">${groupAvatar(cid, cur.name, "big", cur.photo)}${edit ? '<button data-a="photo" aria-label="Change group photo" style="position:absolute;right:-4px;bottom:-4px;width:36px;height:36px;border-radius:50%;border:2px solid #fff;background:#2563eb;color:#fff;font-size:16px">📷</button>' : ""}</div>
    <h2>${esc(cur.name || "Group")}</h2>
    ${cur.description ? `<p style="opacity:.8;margin:2px 0 8px;white-space:pre-wrap">${esc(cur.description)}</p>` : ""}
    <div class="num">${members.length} ${members.length === 1 ? "member" : "members"}${cur.createdBy ? " · created by " + esc(cur.createdBy === me.uid ? "you" : nameOf(cur.createdBy)) : ""}</div>
    <div style="display:flex;gap:8px;margin:8px 0;width:100%"><button class="btn ghost" data-a="gsearch" style="margin:0;flex:1">🔍 Search</button><button class="btn ghost" data-a="gstars" style="margin:0;flex:1">⭐ Starred</button></div>
    <div style="display:flex;gap:8px;margin:0 0 8px;width:100%"><button class="btn ghost" data-a="gttl" style="margin:0;flex:1">⏳ ${esc(ttlLabel())}</button><button class="btn ghost" data-a="gwall" style="margin:0;flex:1">🎨 Wallpaper</button></div>
    ${edit ? '<button class="btn ghost" data-a="edit">Edit name &amp; description</button>' : ""}${edit && cur.photo ? '<button class="btn ghost" data-a="rmphoto">Remove group photo</button>' : ""}
    ${iAdmin ? `<div style="text-align:left;margin:10px 0;border-top:1px solid rgba(128,128,128,.25);padding-top:6px"><b style="font-size:13px;opacity:.7">GROUP SETTINGS</b>${chk("onlyAdminsPost", "Only admins can send messages", "Everyone else can only read")}${chk("membersCanAdd", "Members can add people", "Otherwise only admins can")}${chk("membersCanEdit", "Members can edit group info", "Name, photo and description")}</div>` : ""}
    <div style="text-align:left;max-height:34vh;overflow:auto;margin:10px 0">${members.map(row).join("")}${iAdmin ? '<small style="display:block;opacity:.55;padding:4px">Tap a member to make them admin or remove them.</small>' : ""}</div>
    ${canAddPeople() ? '<button class="btn" data-a="add">Add members</button>' : ""}
    ${iAdmin ? '<button class="btn ghost" data-a="invite">🔗 Invite link</button>' : ""}${iAdmin && cur.inviteCode ? '<button class="btn ghost danger" data-a="revoke">Revoke invite link</button>' : ""}
    <button class="btn ghost danger" data-a="leave">Leave group</button>${iAdmin ? '<button class="btn ghost danger" data-a="delete">Delete group</button>' : ""}<button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onchange = async (e) => {   // settings switches
    const k = e.target.dataset.s; if (!k) return;
    try { await updateDoc(chatRef(), {[k]: e.target.checked}); } catch (err) { e.target.checked = !e.target.checked; fail(err); }
  };
  p.onclick = async (e) => {
    const t = e.target.closest("[data-a],[data-m],[data-s]") || e.target, a = t.dataset.a, mu = t.dataset.m;
    if (!a && !mu) { if (e.target === p) closeModal(p); return; }
    if (a === "x") return closeModal(p);
    if (a === "photo") {   // the file picker must open straight from the tap
      const img = await pickGroupPhoto(); if (!img) return;
      try { await sysMsg(nameOf(me.uid) + " changed the group photo"); await updateDoc(chatRef(), {photo: img}); closeModal(p); toast("Group photo updated."); } catch (err) { fail(err); }
      return;
    }
    closeModal(p); await wait(250);
    const mem = cur.participants || [], adm = cur.admins || [], who = nameOf(me.uid);
    try {
      if (mu) return memberMenu(mu);
      if (a === "rmphoto") { await sysMsg(who + " removed the group photo"); await updateDoc(chatRef(), {photo: ""}); }
      else if (a === "edit") {
        const n = await dialog({title: "Group name", input: "text", value: cur.name || "", ok: "Next"});
        if (n === null) return;
        if (!n.trim()) return toast("The group needs a name.");
        const d = await dialog({title: "Group description", input: "text", value: cur.description || "", ok: "Save"});
        if (d === null) return;
        const upd = {}, nn = n.trim().slice(0, 60), dd = d.trim().slice(0, 200);
        if (nn !== (cur.name || "")) upd.name = nn;
        if (dd !== (cur.description || "")) upd.description = dd;
        if (!Object.keys(upd).length) return;
        if (upd.name) await sysMsg(who + " renamed the group to \"" + nn + "\"");
        await updateDoc(chatRef(), upd);
      } else if (a === "add") {
        const r = await pickPeople({title: "Add members", ok: "Add", exclude: mem});
        if (!r) return;
        if (mem.length + r.ids.length > 100) return toast("A group can have up to 100 people.");
        const upd = {participants: [...mem, ...r.ids]};
        r.ids.forEach((u) => (upd["joinedAt." + u] = serverTimestamp()));
        await sysMsg(who + " added " + r.ids.map((u) => nameOf(u)).join(", "));
        await updateDoc(chatRef(), upd);
      } else if (a === "gsearch") { openFind();
      } else if (a === "gstars") { showStarred();
      } else if (a === "gttl") { ttlMenu();
      } else if (a === "gwall") { wallpaperMenu();
      } else if (a === "invite") { await inviteDialog();
      } else if (a === "revoke") { await revokeInvite();
      } else if (a === "leave") {
        if (!(await dialog({title: "Leave this group?", text: "You will stop getting its messages.", ok: "Leave", danger: true}))) return;
        const rest = mem.filter((x) => x !== me.uid), wasAdmin = adm.includes(me.uid);
        const upd = {participants: rest};
        if (wasAdmin) { const na = adm.filter((x) => x !== me.uid); upd.admins = na.length || !rest.length ? na : [rest[0]]; }   // never leave a group without an admin
        leaving = true;
        await sysMsg(who + " left");
        await updateDoc(chatRef(), upd);
        goHome();
      } else if (a === "delete") await deleteGroup();
    } catch (err) { leaving = false; fail(err); }
  };
}

/* ---------- WhatsApp-style extras ---------- */
document.head.insertAdjacentHTML("beforeend", "<style>.msg{touch-action:pan-y}</style>");   // lets a sideways swipe reach our code while up/down still scrolls
const DAY = 864e5;
let typingT = null;

/* swipe a message to the right to reply */
function startReply(m) { replyTo = m; $("#replytxt").textContent = msgPreview(m); $("#replybar").hidden = false; $("#txt").focus(); }
let sw = null;
function swipeIcon(dx) {
  let ico = document.getElementById("swico");
  if (!ico) {
    ico = document.createElement("div"); ico.id = "swico"; ico.textContent = "↩";
    ico.style.cssText = "position:fixed;left:14px;z-index:9;width:34px;height:34px;border-radius:50%;background:rgba(20,33,61,.85);color:#fff;display:grid;place-items:center;font-size:19px;pointer-events:none";
    document.body.appendChild(ico);
  }
  const r = sw.el.getBoundingClientRect();
  ico.style.top = r.top + r.height / 2 - 17 + "px";
  ico.style.opacity = String(Math.min(1, dx / 45));
  ico.style.transform = dx >= 60 ? "scale(1.15)" : "scale(1)";
}
msgsEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") return;
  const el = e.target.closest(".msg");
  sw = el && !el.classList.contains("del") ? {el, id: el.dataset.id, x: e.clientX, y: e.clientY, dx: 0, on: false, hit: false} : null;
});
msgsEl.addEventListener("pointermove", (e) => {
  if (!sw) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (!sw.on) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }          // the person is scrolling
    if (dx > 14 && dx > Math.abs(dy) * 1.5) { sw.on = true; clearTimeout(lpTimer); sw.el.style.transition = "none"; } else return;
  }
  sw.dx = Math.max(0, Math.min(dx, 90));
  sw.el.style.transform = `translateX(${sw.dx}px)`;
  swipeIcon(sw.dx);
  if (sw.dx >= 60 && !sw.hit) { sw.hit = true; if (navigator.vibrate) navigator.vibrate(12); } else if (sw.dx < 60) sw.hit = false;
});
function endSwipe() {
  if (!sw) return;
  const s = sw; sw = null;
  const ico = document.getElementById("swico"); if (ico) ico.remove();
  if (!s.on) return;
  s.el.style.transition = "transform .18s ease"; s.el.style.transform = "";
  setTimeout(() => (s.el.style.transition = ""), 220);
  lpFired = true;                                           // swallow the tap that follows the swipe
  if (s.dx >= 60) { const m = msgs.find((x) => x.id === s.id); if (m && !m.deleted && !m.pending) startReply(m); }
}
["pointerup", "pointercancel"].forEach((t) => msgsEl.addEventListener(t, endSwipe));

function jumpTo(id) {
  const el = $("#msgs").querySelector('.msg[data-id="' + id + '"]');
  if (!el) return toast("That message is no longer here.");
  el.scrollIntoView({block: "center"});
  const old = el.style.background; el.style.transition = "background .3s"; el.style.background = "rgba(255,201,60,.6)";
  setTimeout(() => (el.style.background = old), 1700);
}

/* pinned message at the top */
const canPin = () => !GROUP || gAdmin();
function renderPin() {
  let bar = document.getElementById("pinbar");
  const p = cur && cur.pinned;
  if (!p || !p.id) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "pinbar";
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--paper);cursor:pointer;font-size:14px";
    $("#msgs").before(bar);
    bar.onclick = (e) => { if (e.target.closest("[data-unpin]")) { updateDoc(chatRef(), {pinned: null}).catch(fail); return; } if (cur && cur.pinned) jumpTo(cur.pinned.id); };
  }
  bar.hidden = false;
  bar.innerHTML = `<span>📌</span><div style="flex:1;min-width:0"><small style="opacity:.65;display:block">Pinned${p.by ? " by " + esc(p.by === me.uid ? "you" : nameOf(p.by)) : ""}</small><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.preview || "Message")}</div></div>${canPin() ? '<button data-unpin aria-label="Unpin" style="font-size:18px;padding:4px 8px">✕</button>' : ""}`;
}
async function pinMsg(m) {
  if (!canPin()) return toast("Only admins can pin messages in this group.");
  const was = cur && cur.pinned && cur.pinned.id === m.id;
  try { await updateDoc(chatRef(), {pinned: was ? null : {id: m.id, preview: msgPreview(m).slice(0, 80), by: me.uid}}); toast(was ? "Unpinned." : "Message pinned."); } catch (err) { fail(err); }
}

/* starred messages */
function showStarred() {
  const p = $("#info"), list = msgs.filter((m) => !m.deleted && isStarred(cid, m.id)).reverse();
  p.innerHTML = `<div class="box"><h2>Starred messages</h2>${list.length ? `<div style="text-align:left;max-height:55vh;overflow:auto;margin:8px 0;width:100%">${list.map((m) => `<button data-id="${m.id}" style="display:block;width:100%;text-align:left;padding:10px 4px;border-bottom:1px solid var(--line)"><small style="opacity:.65">${esc(m.senderId === me.uid ? "You" : nameOf(m.senderId))} · ${esc(dayLabel(ms(m.createdAt)))} ${hm(ms(m.createdAt))}</small><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(msgPreview(m))}</div></button>`).join("")}</div>` : '<p style="opacity:.7">No starred messages yet.<br>Long-press a message and choose Star.</p>'}<button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = (e) => {
    const b = e.target.closest("[data-id]");
    if (b) { closeModal(p); setTimeout(() => jumpTo(b.dataset.id), 350); return; }
    if (e.target.dataset.a === "x" || e.target === p) closeModal(p);
  };
}

/* who has read / received a message */
function showMsgInfo(m) {
  const p = $("#info"), t = ms(m.createdAt), others = ((cur && cur.participants) || []).filter((u) => u !== me.uid);
  const read = [], got = [], sent = [];
  for (const u of others) {
    if (ms(cur.lastRead && cur.lastRead[u]) >= t) read.push(u);
    else if (ms(cur.deliveredAt && cur.deliveredAt[u]) >= t) got.push(u);
    else sent.push(u);
  }
  const sec = (title, list, ic) => (list.length ? `<div style="text-align:left;margin-top:10px;width:100%"><b style="font-size:13px;opacity:.7">${ic} ${title}</b>${list.map((u) => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">${avatar(u, "sm")}<span>${esc(nameOf(u))}</span></div>`).join("")}</div>` : "");
  p.innerHTML = `<div class="box"><h2>Message info</h2><div style="text-align:left;padding:8px 10px;border-radius:10px;background:rgba(128,128,128,.14);margin:6px 0;width:100%;overflow-wrap:anywhere">${esc(msgPreview(m))}<small style="display:block;opacity:.6;margin-top:4px">${esc(dayLabel(t))} ${hm(t)}</small></div>${sec("Read by", read, "✓✓")}${sec("Delivered to", got, "✓✓")}${sec("Sent, not delivered yet", sent, "✓")}<small style="display:block;opacity:.6;margin:10px 0">People who turned off read receipts appear under "Delivered".</small><button class="btn ghost" data-a="x">Close</button></div>`;
  openModal(p);
  p.onclick = (e) => { if (e.target.dataset.a === "x" || e.target === p) closeModal(p); };
}

/* disappearing messages (kept for 24 hours or 7 days, then deleted for everyone) */
const ttlLabel = () => (cur && cur.ttl > 0 ? (cur.ttl >= 7 * DAY ? "7 days" : "24 hours") : "Off");
const isExpired = (m) => !!cur && cur.ttl > 0 && ms(cur.ttlFrom) > 0 && ms(m.createdAt) > ms(cur.ttlFrom) && Date.now() - ms(m.createdAt) >= cur.ttl;
let lastPurge = 0;
function purgeExpired(list) {   // anyone with the chat open removes expired messages, which also frees database space
  if (!cur || !(cur.ttl > 0) || Date.now() - lastPurge < 15000) return;
  const dead = list.filter((m) => !m.pending && isExpired(m)).slice(0, 40);
  if (!dead.length) return;
  lastPurge = Date.now();
  dead.forEach((m) => deleteDoc(doc(db, "chats", cid, "messages", m.id)).catch(() => {}));
}
setInterval(() => {
  if (!unlocked || !cur || !(cur.ttl > 0)) return;
  purgeExpired(raw);
  const keep = raw.filter((m) => !isExpired(m));
  if (keep.length !== raw.length) { raw = keep; decodeAndShow(); }
}, 20000);
function ttlMenu() {
  if (GROUP && !gAdmin()) return toast("Only admins can change disappearing messages.");
  const s = $("#sheet"), now = (cur && cur.ttl) || 0;
  s.innerHTML = `<div class="box"><div style="padding:12px 16px 4px;text-align:center;font-weight:700;opacity:.85">Disappearing messages</div><div style="padding:0 16px 8px;text-align:center;font-size:13px;opacity:.65">New messages in this chat are deleted for everyone after the time you choose.</div><button data-a="0">${!now ? "✓ " : ""}Off</button><button data-a="1">${now === DAY ? "✓ " : ""}24 hours</button><button data-a="7">${now === 7 * DAY ? "✓ " : ""}7 days</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = async (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === undefined || a === "x") return;
    const ttl = a === "1" ? DAY : a === "7" ? 7 * DAY : 0;
    if (ttl === now) return;
    try {
      await sysMsg(nameOf(me.uid) + (ttl ? " turned on disappearing messages (" + (ttl === DAY ? "24 hours" : "7 days") + ")" : " turned off disappearing messages"));
      await updateDoc(chatRef(), {ttl, ttlFrom: serverTimestamp()});
      toast(ttl ? "Disappearing messages: " + (ttl === DAY ? "24 hours" : "7 days") : "Disappearing messages turned off.");
    } catch (err) { fail(err); }
  };
}

/* wallpapers */
function applyWall() {
  const w = WALLS[wallOf(cid)] || WALLS.default, dark = document.documentElement.dataset.theme === "dark";
  $("#msgs").style.background = (dark ? w.dark : w.light) || "";
}
function wallpaperMenu() {
  const d = $("#dlg"), dark = document.documentElement.dataset.theme === "dark", now = wallOf(cid);
  d.innerHTML = `<div class="dbox"><h3>Chat wallpaper</h3><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0">${Object.entries(WALLS).map(([k, w]) => `<button data-w="${k}" style="height:62px;border-radius:12px;border:2.5px solid ${k === now ? "#34B7F1" : "rgba(128,128,128,.4)"};background:${(dark ? w.dark : w.light) || "var(--paper)"};color:${k === "night" ? "#fff" : "inherit"};font-size:12px;font-weight:600">${w.label}</button>`).join("")}</div><label style="display:flex;gap:8px;align-items:center;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="wAll" style="width:18px;height:18px"> Use for all chats</label><div class="dact"><button data-a="c">Close</button></div></div>`;
  d.hidden = false;
  d.onclick = (e) => {
    const k = e.target.dataset.w;
    if (k) {
      if ($("#wAll").checked) setWall("*", k);
      setWall(cid, k);
      d.querySelectorAll("[data-w]").forEach((b) => (b.style.borderColor = b.dataset.w === k ? "#34B7F1" : "rgba(128,128,128,.4)"));
      return;
    }
    if (e.target.dataset.a === "c" || e.target === d) { d.hidden = true; d.onclick = null; }
  };
}

/* attach menu: photo, poll, location, contact */
function attachMenu() {
  const s = $("#sheet");
  s.innerHTML = `<div class="box"><button data-a="photo">📷 Photo</button><button data-a="poll">📊 Poll</button><button data-a="loc">📍 Location</button><button data-a="ct">👤 Contact</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    if (a === "photo") $("#file").click();                     // must run straight from the tap
    if (a === "poll") setTimeout(createPoll, 250);
    if (a === "loc") shareLocation();
    if (a === "ct") setTimeout(shareContact, 250);
  };
}
function pollDialog() {
  return new Promise((res) => {
    const d = $("#dlg"), st = "width:100%;padding:.65rem .8rem;border-radius:.7rem;border:1.5px solid var(--line);background:transparent;color:inherit;outline:0;margin-bottom:.5rem;font:inherit";
    d.innerHTML = `<div class="dbox"><h3>Create poll</h3><input id="pq" maxlength="120" placeholder="Ask a question" style="${st}">${[1, 2, 3, 4].map((i) => `<input class="po" maxlength="60" placeholder="Option ${i}${i > 2 ? " (optional)" : ""}" style="${st}">`).join("")}<label style="display:flex;gap:8px;align-items:center;margin:4px 0 10px;cursor:pointer"><input type="checkbox" id="pm" style="width:18px;height:18px"> Allow multiple answers</label><div class="dact"><button data-a="c">Cancel</button><button data-a="o">Send</button></div></div>`;
    d.hidden = false;
    const done = (v) => { d.hidden = true; d.onclick = null; res(v); };
    d.onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === "o") {
        const q = $("#pq").value.trim(), opts = [...d.querySelectorAll(".po")].map((x) => x.value.trim()).filter(Boolean);
        if (!q) return toast("Type a question.");
        if (opts.length < 2) return toast("Add at least two options.");
        done({question: q, options: opts, multi: $("#pm").checked});
      } else if (a === "c" || e.target === d) done(null);
    };
    $("#pq").focus();
  });
}
async function createPoll() {
  const p = await pollDialog();
  if (p) sendMessage({type: "poll", question: p.question, options: p.options, multi: p.multi, votes: {}}, "📊 " + p.question);
}
function votePoll(id, i) {
  const m = msgs.find((x) => x.id === id);
  if (!m || m.deleted || m.pending) return;
  const mine = (m.votes && m.votes[me.uid]) || [];
  const next = m.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : (mine.includes(i) ? [] : [i]);
  updateDoc(doc(db, "chats", cid, "messages", id), {["votes." + me.uid]: next}).catch((err) => { console.error(err); toast("Could not save your vote."); });
}
function shareLocation() {
  if (!navigator.geolocation) return toast("Location is not available on this device.");
  toast("Getting your location…");
  navigator.geolocation.getCurrentPosition(async (p) => {
    const lat = p.coords.latitude, lng = p.coords.longitude, acc = Math.round(p.coords.accuracy || 0);
    if (await dialog({title: "Share your location?", text: lat.toFixed(5) + ", " + lng.toFixed(5) + (acc ? " (about " + acc + " m)" : ""), ok: "Send"})) sendMessage({type: "location", lat, lng, acc}, "📍 Location");
  }, (err) => toast(err.code === 1 ? "Location permission was denied." : "Could not get your location."), {enableHighAccuracy: true, timeout: 12000, maximumAge: 30000});
}
async function shareContact() {
  const r = await pickPeople({title: "Share contact", ok: "Send", exclude: GROUP ? [] : [peerUid]});
  if (!r) return;
  for (const u of r.ids) { const p = people[u] || {}; watch(u); await sendMessage({type: "contact", uid: u, name: nameOf(u), phone: p.phone || "", email: p.email || ""}, "👤 " + nameOf(u)); }
}

/* full-screen contact info (tap the name at the top of a 1:1 chat) */
function openInfoScreen(el) { if (el.hidden) history.pushState({cinfo: 1}, ""); el.hidden = false; }
function closeInfoScreen(el) { if (el.hidden) return; el.hidden = true; if (history.state && history.state.cinfo) history.back(); }
onBack((s) => { const el = document.getElementById("cinfo"); if (el && !s.cinfo && !s.modal) el.hidden = true; });
function chatMuteMenu() {
  if (isMuted(cid)) { setMute(cid).then((ok) => ok && toast("Unmuted.")); return; }
  const s = $("#sheet");
  s.innerHTML = `<div class="box"><div style="padding:12px 16px 8px;text-align:center;font-weight:700;opacity:.85">Mute notifications</div><button data-a="8h">🔇 For 8 hours</button><button data-a="1w">🔇 For 1 week</button><button data-a="all">🔇 Always</button><button data-a="x">Cancel</button></div>`;
  openModal(s);
  s.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a && ev.target !== s) return;
    closeModal(s);
    const until = a === "8h" ? Date.now() + 8 * 3600e3 : a === "1w" ? Date.now() + 7 * DAY : a === "all" ? 0 : null;
    if (until !== null) setMute(cid, until).then((ok) => ok && toast("Muted."));
  };
}
function renderContactInfo() {
  const el = document.getElementById("cinfo"); if (!el) return;
  const uid = peerUid, u = people[uid] || {}, self = isSelf(), name = nameOf(uid);
  const status = self ? "Message yourself" : hidden(u) ? "" : online(u) ? "online" : u.lastActive ? "last seen " + dayLabel(ms(u.lastActive)).toLowerCase() + " at " + hm(ms(u.lastActive)) : "";
  const pic = u.photoUrl ? `<img data-a="photo" src="${esc(u.photoUrl)}" alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;border-radius:50%;object-fit:cover;cursor:pointer">` : `<div style="width:100%;height:100%;border-radius:50%;background:#14213D;color:#FFC93C;display:grid;place-items:center;font-size:56px;font-weight:700">${esc((name[0] || "?").toUpperCase())}</div>`;
  const act = (a, ic, t) => `<button data-a="${a}" style="flex:1;display:grid;place-items:center;gap:4px;padding:12px 4px;border-radius:14px;background:rgba(128,128,128,.12);font-size:13px;font-weight:600"><span style="font-size:22px">${ic}</span>${t}</button>`;
  const row = (a, ic, t, sub, danger) => `<button data-a="${a}" style="display:flex;align-items:center;gap:16px;width:100%;padding:14px 20px;text-align:left;border-top:1px solid var(--line);background:none;${danger ? "color:#d93025;" : ""}"><span style="font-size:22px;width:28px;text-align:center">${ic}</span><span style="flex:1;min-width:0"><span style="display:block;font-weight:600">${t}</span>${sub ? `<small style="opacity:.65">${sub}</small>` : ""}</span></button>`;
  const stars = msgs.filter((m) => !m.deleted && isStarred(cid, m.id)).length;
  el.innerHTML = `<div style="position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px;padding-top:max(10px,env(safe-area-inset-top));background:#14213D;color:#fff"><button data-a="x" aria-label="Back" style="color:#fff;font-size:22px;width:38px;height:38px">&#8592;</button><b style="font-size:17px">Contact info</b></div>
    <div style="text-align:center;padding:24px 16px 14px"><div style="width:140px;height:140px;margin:0 auto 12px">${pic}</div><div style="font-size:22px;font-weight:700">${esc(name)}${self ? " (You)" : ""}</div>${u.phone ? `<div style="opacity:.8;margin-top:2px">${esc(u.phone)}</div>` : ""}${u.email ? `<div style="opacity:.8">${esc(u.email)}</div>` : ""}${status ? `<div style="opacity:.65;margin-top:6px">${esc(status)}</div>` : ""}</div>
    <div style="display:flex;gap:10px;padding:0 16px 14px">${self ? "" : act("call", "📞", "Call")}${act("search", "🔍", "Search")}${self ? "" : act("mute", isMuted(cid) ? "🔔" : "🔇", isMuted(cid) ? "Unmute" : "Mute")}</div>
    ${u.bio ? `<div style="padding:12px 20px;border-top:1px solid var(--line)"><small style="opacity:.6">About</small><div style="overflow-wrap:anywhere;white-space:pre-wrap">${esc(u.bio)}</div></div>` : ""}
    ${row("stars", "⭐", "Starred messages", stars ? stars + " in this chat" : "None yet")}
    ${row("ttl", "⏳", "Disappearing messages", ttlLabel())}
    ${row("wall", "🎨", "Chat wallpaper", WALLS[wallOf(cid)] ? WALLS[wallOf(cid)].label : "")}
    ${self ? "" : row("block", "🚫", isBlocked(uid) ? "Unblock " + esc(name) : "Block " + esc(name), "", true)}
    <div style="height:max(24px,env(safe-area-inset-bottom))"></div>`;
}
function showContactInfo() {
  if (GROUP) return;
  let el = document.getElementById("cinfo");
  if (!el) {
    el = document.createElement("div"); el.id = "cinfo"; el.hidden = true;
    el.style.cssText = "position:fixed;inset:0;z-index:9;background:var(--paper);overflow-y:auto;-webkit-overflow-scrolling:touch";
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]"); if (!b) return;
      const a = b.dataset.a;
      if (a === "x") return closeInfoScreen(el);
      if (a === "photo") { const ph = (people[peerUid] || {}).photoUrl; if (ph) openViewer(ph); return; }
      if (a === "call") { closeInfoScreen(el); setTimeout(() => startCall(peerUid), 300); return; }
      if (a === "search") { closeInfoScreen(el); setTimeout(openFind, 300); return; }
      if (a === "mute") return chatMuteMenu();
      if (a === "stars") return showStarred();
      if (a === "ttl") return ttlMenu();
      if (a === "wall") return wallpaperMenu();
      if (a === "block") return toggleBlock(peerUid);
    });
  }
  renderContactInfo();
  openInfoScreen(el);
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
