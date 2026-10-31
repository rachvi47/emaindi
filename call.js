// call.js - WhatsApp-style voice calls using WebRTC. Firestore carries the "ringing" signals.
// Works on both home.html and chat.html. Both people need the app open (online) for a call to ring.
import {db, doc, collection, setDoc, addDoc, updateDoc, onSnapshot, query, where, serverTimestamp, increment} from "./fire.js";
import {$, esc, ms, me, nameOf, avatar, toast, chatId, onBack, watch} from "./common.js";

// STUN finds your public address. Calls on some mobile networks also need a TURN relay:
// add one below, for example  {urls: "turn:YOUR_HOST:3478", username: "USER", credential: "PASS"}
const ICE = {iceServers: [{urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}]};

let call = null, initialized = false, ctx = null, ringTimer = null;
export const inCall = () => !!call;

/* ---------- screen ---------- */
function ensureUI() {
  if ($("#callui")) return $("#callui");
  const st = document.createElement("style");
  st.textContent = `#callui{position:fixed;inset:0;z-index:60;background:linear-gradient(#14213D,#0b1220);color:#fff;display:flex;align-items:center;justify-content:center;padding:2rem}
#callui .cwrap{text-align:center;width:100%;max-width:22rem}
#callui h2{margin:1rem 0 .3rem;font-size:1.6rem}
#callui #cstat{color:#cfd5e6;margin:0 0 2.5rem;min-height:1.4em}
#callui .cbtns{display:flex;justify-content:center;gap:2rem}
#callui .cbtn{width:4.2rem;height:4.2rem;border-radius:50%;font-size:1.6rem;background:rgba(255,255,255,.16);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}
#callui .cbtn small{position:absolute;bottom:-1.5rem;font-size:.72rem;color:#cfd5e6;white-space:nowrap}
#callui .cbtn.red{background:#d93025}#callui .cbtn.green{background:#1a9c4a}#callui .cbtn.on{background:#fff;color:#14213D}
#callui .cbtn.red span{display:inline-block;transform:rotate(135deg)}
#callui .av.big{width:7rem;height:7rem;font-size:2.8rem;margin:0 auto}`;
  document.head.appendChild(st);
  const d = document.createElement("div"); d.id = "callui"; d.hidden = true; document.body.appendChild(d);
  const a = document.createElement("audio"); a.id = "callaudio"; a.autoplay = true; a.setAttribute("playsinline", ""); document.body.appendChild(a);
  d.addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]"); if (!b) return;
    const k = b.dataset.c;
    if (k === "accept") accept();
    if (k === "decline" || k === "end") endCall();
    if (k === "mute" && call) { call.muted = !call.muted; call.stream && call.stream.getAudioTracks().forEach((t) => (t.enabled = !call.muted)); paint(); }
  });
  return d;
}
const fmtDur = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
function statText() {
  if (!call) return "";
  return call.state === "incoming" ? "Incoming voice call…" : call.state === "calling" ? "Calling…" : call.state === "connecting" ? "Connecting…" : fmtDur(Math.round((Date.now() - call.t0) / 1000));
}
function paint() {
  const d = ensureUI();
  if (!call) { d.hidden = true; d.innerHTML = ""; return; }
  const inc = call.state === "incoming";
  d.innerHTML = `<div class="cwrap">${avatar(call.peer, "big")}<h2>${esc(nameOf(call.peer))}</h2><p id="cstat">${statText()}</p>
    <div class="cbtns">${inc
      ? '<button class="cbtn red" data-c="decline"><span>📞</span><small>Decline</small></button><button class="cbtn green" data-c="accept">📞<small>Accept</small></button>'
      : `<button class="cbtn ${call.muted ? "on" : ""}" data-c="mute">${call.muted ? "🔇" : "🎤"}<small>${call.muted ? "Unmute" : "Mute"}</small></button><button class="cbtn red" data-c="end"><span>📞</span><small>End</small></button>`}</div></div>`;
  d.hidden = false;
}

/* ---------- ringing sound ---------- */
function audioCtx() { try { ctx = ctx || new AudioContext(); if (ctx.state === "suspended") ctx.resume(); } catch (e) {} return ctx; }
addEventListener("pointerdown", audioCtx, {passive: true});     // browsers only allow sound after a first touch
function tone(freq, dur) {
  const c = audioCtx(); if (!c) return;
  try { const o = c.createOscillator(), g = c.createGain(); o.frequency.value = freq; g.gain.value = 0.1; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + dur); } catch (e) {}
}
function ringStart(incoming) {
  ringStop();
  const play = () => { tone(incoming ? 880 : 440, 0.35); setTimeout(() => tone(incoming ? 660 : 440, 0.35), 450); if (incoming && navigator.vibrate) navigator.vibrate([300, 200, 300]); };
  play(); ringTimer = setInterval(play, 2200);
}
function ringStop() { clearInterval(ringTimer); ringTimer = null; if (navigator.vibrate) navigator.vibrate(0); }

/* ---------- helpers ---------- */
function guardBack() { history.pushState({call: 1}, ""); }
onBack((s) => { if (call && !s.call) { history.pushState({call: 1}, ""); toast("Tap End to finish the call first."); } });

function callNotif(on) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready.then((r) => {
    if (on) { if (document.hidden && "Notification" in window && Notification.permission === "granted") r.showNotification(nameOf(call.peer), {body: "Incoming voice call", tag: "call", requireInteraction: true, vibrate: [300, 200, 300]}); }
    else r.getNotifications({tag: "call"}).then((l) => l.forEach((n) => n.close()));
  }).catch(() => {});
}
async function getMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Calls need a secure (https) page with microphone support.");
  return navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}});
}
function makePC() {
  const c = call, pc = new RTCPeerConnection(ICE);
  c.pc = pc;
  c.stream.getTracks().forEach((t) => pc.addTrack(t, c.stream));
  pc.ontrack = (e) => { const a = $("#callaudio"); a.srcObject = e.streams[0]; a.play().catch(() => {}); };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    const s = pc.connectionState;
    if (s === "connected" && call.state !== "active") setActive();
    if (s === "failed") { toast("The call could not connect. Try again, or use a TURN server for this network."); endCall(); }
    if (s === "disconnected") setTimeout(() => { if (call && call.pc === pc && pc.connectionState === "disconnected") { toast("Call lost."); endCall(); } }, 6000);
  };
  return pc;
}
function setActive() {
  call.state = "active"; call.t0 = Date.now(); ringStop(); paint();
  call.timer = setInterval(() => { const s = $("#cstat"); if (s && call) s.textContent = statText(); }, 1000);
}
function addRemoteCand(c) {
  if (!call || !call.pc) return;
  if (call.pc.remoteDescription) call.pc.addIceCandidate(c).catch(() => {}); else call.pending.push(c);
}
function flushPending() { const c = call; if (!c) return; c.pending.splice(0).forEach((x) => c.pc.addIceCandidate(x).catch(() => {})); }

function cleanup() {
  const c = call; call = null;
  if (!c) return;
  ringStop(); clearInterval(c.timer); clearTimeout(c.timeout);
  c.unsubs.forEach((u) => { try { u(); } catch (e) {} });
  try { c.pc && c.pc.close(); } catch (e) {}
  try { c.stream && c.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  const a = $("#callaudio"); if (a) a.srcObject = null;
  paint();
  c.cleanedFor = c.peer;
  if (history.state && history.state.call) history.back();
  return c;
}
function logCall(peerUid, status, dur) {      // the caller writes one line into the chat, like WhatsApp
  const id = chatId(me.uid, peerUid);
  const text = status === "ended" ? "Voice call" : status === "declined" ? "Call declined" : "Missed voice call";
  addDoc(collection(db, "chats", id, "messages"), {senderId: me.uid, type: "call", callStatus: status, dur, text, createdAt: serverTimestamp(), deleted: false}).catch(() => {});
  setDoc(doc(db, "chats", id), {participants: [me.uid, peerUid].sort(), lastMessage: "📞 " + text, lastMessageAt: serverTimestamp(), lastSender: me.uid, unread: {[peerUid]: increment(status === "ended" ? 0 : 1)}}, {merge: true}).catch(() => {});
}
function finish(status) {
  const c = call; if (!c) return;
  const dur = c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0;
  callNotif(false);
  cleanup();
  if (c.role === "caller") logCall(c.peer, status, dur);
  toast(status === "declined" ? "Call declined." : status === "missed" ? (c.role === "caller" ? "No answer." : "Call ended.") : dur ? "Call ended · " + fmtDur(dur) : "Call ended.");
}
function fail(e) {
  console.error(e);
  const m = e && e.name === "NotAllowedError" ? "Allow the microphone to use calls." : (e && e.message) || "The call failed.";
  const c = call;
  if (c && c.ref) updateDoc(c.ref, {status: c.role === "caller" ? "missed" : "declined"}).catch(() => {});
  callNotif(false); cleanup(); toast(m);
}
function endCall() {
  const c = call; if (!c) return;
  const status = c.role === "callee" && c.state === "incoming" ? "declined" : c.state === "calling" ? "missed" : "ended";
  updateDoc(c.ref, {status, endedBy: me.uid}).catch(() => {});
  finish(status);
}

/* ---------- start a call (caller) ---------- */
export async function startCall(peerUid) {
  if (call) return toast("You're already in a call.");
  if (!navigator.onLine) return toast("You're offline. Calls need internet.");
  const ref = doc(collection(db, "calls"));
  call = {id: ref.id, ref, peer: peerUid, role: "caller", state: "calling", unsubs: [], pending: [], queue: [], ready: false, muted: false};
  const c = call;
  paint(); guardBack(); ringStart(false);
  try { c.stream = await getMic(); } catch (e) { return fail(e); }
  if (call !== c) return;
  const pc = makePC();
  const sendCand = (x) => addDoc(collection(db, "calls", c.id, "callerCandidates"), x).catch(() => {});
  pc.onicecandidate = (e) => { if (!e.candidate) return; if (c.ready) sendCand(e.candidate.toJSON()); else c.queue.push(e.candidate.toJSON()); };
  try {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await setDoc(ref, {callerId: me.uid, calleeId: peerUid, status: "ringing", offer: {type: offer.type, sdp: offer.sdp}, createdAt: serverTimestamp()});
    c.ready = true; c.queue.splice(0).forEach(sendCand);
  } catch (e) { return fail(e); }
  c.unsubs.push(onSnapshot(ref, async (s) => {
    const d = s.data(); if (!d || call !== c) return;
    if (d.answer && !pc.currentRemoteDescription) {
      try { await pc.setRemoteDescription(d.answer); flushPending(); } catch (e) { return fail(e); }
      ringStop(); if (c.state === "calling") { c.state = "connecting"; paint(); }
    }
    if (["ended", "declined", "missed"].includes(d.status)) finish(d.status);
  }));
  c.unsubs.push(onSnapshot(collection(db, "calls", c.id, "calleeCandidates"), (s) => s.docChanges().forEach((ch) => ch.type === "added" && addRemoteCand(ch.doc.data()))));
  c.timeout = setTimeout(() => { if (call === c && c.state === "calling") { updateDoc(ref, {status: "missed"}).catch(() => {}); finish("missed"); } }, 45000);
}

/* ---------- receive a call (callee) ---------- */
function incoming(snap) {
  const d = snap.data();
  watch(d.callerId);
  call = {id: snap.id, ref: snap.ref, peer: d.callerId, role: "callee", state: "incoming", offer: d.offer, unsubs: [], pending: [], muted: false};
  const c = call;
  paint(); guardBack(); ringStart(true); callNotif(true);
  c.unsubs.push(onSnapshot(snap.ref, (s) => { const x = s.data(); if (call === c && x && ["ended", "missed", "declined"].includes(x.status)) finish(x.status); }));
}
async function accept() {
  const c = call; if (!c || c.state !== "incoming") return;
  ringStop(); callNotif(false); c.state = "connecting"; paint();
  try { c.stream = await getMic(); } catch (e) { return fail(e); }
  if (call !== c) return;
  const pc = makePC();
  pc.onicecandidate = (e) => e.candidate && addDoc(collection(db, "calls", c.id, "calleeCandidates"), e.candidate.toJSON()).catch(() => {});
  c.unsubs.push(onSnapshot(collection(db, "calls", c.id, "callerCandidates"), (s) => s.docChanges().forEach((ch) => ch.type === "added" && addRemoteCand(ch.doc.data()))));
  try {
    await pc.setRemoteDescription(c.offer); flushPending();
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    await updateDoc(c.ref, {answer: {type: ans.type, sdp: ans.sdp}, status: "active", answeredAt: serverTimestamp()});
  } catch (e) { fail(e); }
}

/* ---------- listen for incoming calls (call this once after login) ---------- */
export function initCalls() {
  if (initialized || !me || me.cached) return;
  initialized = true;
  ensureUI();
  onSnapshot(query(collection(db, "calls"), where("calleeId", "==", me.uid), where("status", "==", "ringing")), (s) => {
    s.docChanges().forEach((ch) => {
      if (ch.type !== "added") return;
      const d = ch.doc.data();
      if (Date.now() - ms(d.createdAt) > 60000) return;            // an old call that was never closed
      if (call) { updateDoc(ch.doc.ref, {status: "declined", reason: "busy"}).catch(() => {}); return; }
      incoming(ch.doc);
    });
  }, (e) => console.warn("Call listener:", e.code || e));
  addEventListener("pagehide", () => { if (call) updateDoc(call.ref, {status: call.state === "calling" ? "missed" : "ended"}).catch(() => {}); });
}
