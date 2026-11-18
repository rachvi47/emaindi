import {auth,db,onAuthStateChanged,signOut,doc,getDoc,setDoc,collection,query,where,orderBy,onSnapshot,getDocs,addDoc,updateDoc,serverTimestamp,increment} from "../fire.js";

const $ = (s) => document.querySelector(s);
const appShell = $(".app-shell");
const state = {user:null,profile:{},chats:[],people:{},activeChat:null,chatUnsub:null,listUnsub:null,messageUnsub:null,searchTimer:null};
let toastTimer;
function toast(message){const el=$("#toast");el.textContent=message;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3600)}
function safeText(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function timeOf(value){if(!value)return 0;if(typeof value.toMillis==="function")return value.toMillis();const n=Date.parse(value);return Number.isFinite(n)?n:0}
function clock(value){const n=timeOf(value);return n?new Date(n).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):""}
function day(value){const n=timeOf(value);if(!n)return "";const d=new Date(n),now=new Date();return d.toDateString()===now.toDateString()?clock(value):d.toLocaleDateString([],{day:"numeric",month:"short"})}
function nameOf(uid){const p=state.people[uid]||{};return p.name||p.displayName||p.phone||p.email||"Emaindi user"}
function initials(uid){const n=nameOf(uid).trim();return (n[0]||"?").toUpperCase()}
function avatarHTML(uid){return '<div class="avatar">'+safeText(initials(uid))+'</div>'}
function chatId(a,b){return [a,b].sort().join("_")}
function peerOf(chat){return (chat.participants||[]).find(uid=>uid!==state.user.uid)||state.user.uid}
function setSync(text,ok=false){$("#sync-state").textContent=text;$("#sync-state").style.color=ok?"#16856b":""}
function showWelcome(){state.activeChat=null;state.messageUnsub?.();state.messageUnsub=null;$("#thread").hidden=true;$("#welcome").hidden=false;appShell.classList.remove("chat-open");renderChats()}
function renderChats(){
  const queryText=$("#search").value.trim().toLowerCase();
  const list=$("#chat-list");
  const chats=state.chats.filter(c=>{const peer=peerOf(c),p=state.people[peer]||{};return !queryText||[nameOf(peer),p.email,p.phone,c.lastMessage].join(" ").toLowerCase().includes(queryText)});
  if(!chats.length){list.innerHTML='<div class="state-card">'+(queryText?"No matching chats. Search for a full email or phone number below.":"No conversations found for this account.")+'</div>';return}
  list.innerHTML=chats.map(c=>{const peer=peerOf(c),selected=state.activeChat?.id===c.id;return '<button class="chat-row '+(selected?"selected":"")+'" data-chat-id="'+safeText(c.id)+'">'+avatarHTML(peer)+'<span class="chat-meta"><strong>'+safeText(nameOf(peer))+'</strong><small>'+safeText(c.lastMessage||"Start a conversation")+'</small></span><span class="chat-time">'+safeText(day(c.lastMessageAt))+'</span></button>'}).join("");
  list.querySelectorAll("[data-chat-id]").forEach(el=>el.addEventListener("click",()=>openChat(el.dataset.chatId)));
}
async function loadProfile(user){
  const ref=doc(db,"users",user.uid);const snap=await getDoc(ref);
  state.profile=snap.exists()?snap.data():{};
  if(!snap.exists()){await setDoc(ref,{uid:user.uid,name:user.displayName||"",email:user.email||"",phone:user.phoneNumber||"",photoUrl:user.photoURL||"",createdAt:serverTimestamp()},{merge:true});state.profile={uid:user.uid,name:user.displayName||"",email:user.email||"",phone:user.phoneNumber||""}}
  state.people[user.uid]=state.profile;
  $("#my-name").textContent=state.profile.name||user.displayName||user.email||user.phoneNumber||"My account";
  $("#my-avatar").textContent=(state.profile.name||user.displayName||"E").trim()[0]?.toUpperCase()||"E";
}
function listenForChats(){
  state.listUnsub?.();
  const q=query(collection(db,"chats"),where("participants","array-contains",state.user.uid));
  state.listUnsub=onSnapshot(q,{includeMetadataChanges:true},snap=>{
    state.chats=snap.docs.map(d=>({id:d.id,...d.data({serverTimestamps:"estimate"})}));
    state.chats.sort((a,b)=>timeOf(b.lastMessageAt)-timeOf(a.lastMessageAt));
    setSync(snap.metadata.fromCache?"Offline cache · waiting for server":"Synced with Firebase",!snap.metadata.fromCache);
    const peers=[...new Set(state.chats.flatMap(c=>c.participants||[]).filter(uid=>uid!==state.user.uid))];
    peers.forEach(loadPerson);
    renderChats();
    if(state.activeChat){const latest=state.chats.find(c=>c.id===state.activeChat.id);if(latest)state.activeChat=latest}
  },err=>{console.error("Chat-list listener:",err);setSync("Sync error: "+(err.code||err.message));toast("Chat list could not sync: "+(err.code||err.message))});
}
async function loadPerson(uid){
  if(state.people[uid])return;
  try{const snap=await getDoc(doc(db,"users",uid));if(snap.exists()){state.people[uid]=snap.data();renderChats();if(state.activeChat&&peerOf(state.activeChat)===uid)renderPeer()}}catch(e){console.warn("Profile read failed",uid,e)}
}
async function searchPeople(term){
  const list=$("#chat-list");const trimmed=term.trim();if(!trimmed)return renderChats();
  const email=trimmed.includes("@"),digits=trimmed.replace(/[\s().-]/g,"");
  if(!email&&!/^\+?\d{6,15}$/.test(digits)){renderChats();return}
  try{
    const q=email?query(collection(db,"users"),where("email","==",trimmed.toLowerCase())):query(collection(db,"users"),where("phone","==",digits.startsWith("+")?digits:"+"+digits));
    const snap=await getDocs(q);const users=snap.docs.map(d=>({uid:d.id,...d.data()})).filter(u=>u.uid!==state.user.uid);
    if(!users.length){renderChats();toast("No account found for that email or phone number.");return}
    users.forEach(u=>state.people[u.uid]=u);
    list.innerHTML=users.map(u=>'<button class="chat-row" data-user-id="'+safeText(u.uid)+'">'+avatarHTML(u.uid)+'<span class="chat-meta"><strong>'+safeText(nameOf(u.uid))+'</strong><small>'+safeText(u.email||u.phone||"Emaindi user")+'</small></span></button>').join("");
    list.querySelectorAll("[data-user-id]").forEach(el=>el.addEventListener("click",()=>startChat(el.dataset.userId)));
  }catch(err){console.error("User search:",err);toast("People search failed: "+(err.code||err.message))}
}
async function startChat(uid){
  const id=chatId(state.user.uid,uid),ref=doc(db,"chats",id),snap=await getDoc(ref);
  if(!snap.exists()){
    await setDoc(ref,{participants:[state.user.uid,uid].sort(),createdBy:state.user.uid,createdAt:serverTimestamp(),lastMessage:"",lastMessageAt:serverTimestamp()},{merge:true});
  }else{
    const participants=snap.data().participants;
    if(!Array.isArray(participants)||!participants.includes(state.user.uid)||!participants.includes(uid)){toast("This conversation does not match the expected participants.");return}
  }
  await loadPerson(uid);const chat=state.chats.find(c=>c.id===id)||{id,participants:[state.user.uid,uid].sort(),lastMessage:""};openChat(id,chat)
}
function renderPeer(){if(!state.activeChat)return;const uid=peerOf(state.activeChat);$("#peer-avatar").textContent=initials(uid);$("#peer-name").textContent=nameOf(uid);const p=state.people[uid]||{};$("#peer-detail").textContent=p.phone||p.email||"Emaindi conversation"}
function renderMessages(messages){
  const box=$("#messages");if(!messages.length){box.innerHTML='<div class="state-card">This conversation is ready. Send the first message.</div>';return}
  box.innerHTML=messages.map(m=>{const mine=m.senderId===state.user.uid;return '<article class="message '+(mine?"mine":"")+'">'+safeText(m.deleted?"This message was deleted":m.text||"")+'<time class="message-time">'+safeText(clock(m.createdAt))+'</time></article>'}).join("");
  box.scrollTop=box.scrollHeight;
}
function openChat(id,known){
  const chat=known||state.chats.find(c=>c.id===id);if(!chat){toast("Conversation not found in this account.");return}
  state.activeChat=chat;renderPeer();$("#welcome").hidden=true;$("#thread").hidden=false;appShell.classList.add("chat-open");renderChats();
  state.messageUnsub?.();
  $("#messages").innerHTML='<div class="state-card">Connecting to this conversation…</div>';
  const q=query(collection(db,"chats",id,"messages"),orderBy("createdAt","asc"));
  state.messageUnsub=onSnapshot(q,{includeMetadataChanges:true},snap=>{
    const rows=snap.docs.map(d=>({id:d.id,...d.data({serverTimestamps:"estimate"})}));
    renderMessages(rows);$("#thread-state").textContent=snap.metadata.fromCache?"CACHED":"LIVE";
  },err=>{console.error("Message listener:",err);$("#messages").innerHTML='<div class="state-card">Messages could not sync.<br>'+safeText(err.code||err.message)+'</div>';$("#thread-state").textContent="ERROR"});
}
async function sendMessage(text){
  const chat=state.activeChat;if(!chat)return;
  const value=text.trim();if(!value)return;
  if(value.length>5000){toast("Messages are limited to 5,000 characters.");return}
  const peer=peerOf(chat),ref=doc(db,"chats",chat.id);
  $("#message-input").value="";
  try{
    await addDoc(collection(db,"chats",chat.id,"messages"),{senderId:state.user.uid,text:value,type:"text",createdAt:serverTimestamp(),deleted:false});
    const update={lastMessage:value.slice(0,200),lastMessageAt:serverTimestamp(),lastSender:state.user.uid};
    if(peer!==state.user.uid)update["unread."+peer]=increment(1);
    await updateDoc(ref,update);
  }catch(err){console.error("Send failed:",err);toast("Message was not sent: "+(err.code||err.message));$("#message-input").value=value}
}
$("#composer").addEventListener("submit",e=>{e.preventDefault();sendMessage($("#message-input").value)});
$("#message-input").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("#composer").requestSubmit()}});
$("#message-input").addEventListener("input",e=>{e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,130)+"px"});
$("#search").addEventListener("input",()=>{clearTimeout(state.searchTimer);const value=$("#search").value;renderChats();if(value.trim())state.searchTimer=setTimeout(()=>searchPeople(value),450)});
$("#back").addEventListener("click",showWelcome);
$("#logout").addEventListener("click",async()=>{try{await signOut(auth)}catch(e){toast("Could not sign out: "+e.message)}});
onAuthStateChanged(auth,async user=>{
  if(!user){location.replace("./login.html");return}
  state.user=user;
  try{await loadProfile(user);listenForChats()}catch(err){console.error("App startup:",err);setSync("Account setup error");toast("Could not load your account: "+(err.code||err.message))}
});
window.addEventListener("pagehide",()=>{state.listUnsub?.();state.messageUnsub?.()});
