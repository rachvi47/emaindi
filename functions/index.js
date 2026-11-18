// functions/index.js - sends a push notification when a new chat message arrives.
const {onDocumentUpdated} = require("firebase-functions/v2/firestore");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const webpush = require("web-push");

initializeApp();
const db = getFirestore();

// >>> 1. Must match VAPID_PUBLIC_KEY in push.js. <<<
const VAPID_PUBLIC_KEY = "BNYZQbMRbD-iwGc3d4ZsZArmE5DFk-KdTJ3QBm1HqxtI23srWMWZK9BUG5F90VMyPu3WKFKfqm4DOe2al-3QfTc";
// >>> 2. Must be the same region as your Firestore database (Firebase console > Firestore > Data shows it).
//        Examples: "us-central1", "asia-south1" (Mumbai), "europe-west1". <<<
const REGION = "us-central1";
// The private key is kept as a Firebase secret (never in a file): firebase functions:secrets:set VAPID_PRIVATE_KEY
const VAPID_PRIVATE_KEY = defineSecret("VAPID_PRIVATE_KEY");

const millis = (t) => (t && t.toMillis ? t.toMillis() : 0);

// the name the receiver sees: their saved contact name first, then the sender's profile (same order as the app)
async function senderName(recipient, sender) {
  const c = await db.doc(`users/${recipient}/contacts/${sender}`).get();
  if (c.exists && c.data().name) return c.data().name;
  const u = await db.doc(`users/${sender}`).get();
  const d = u.exists ? u.data() : {};
  return d.name || d.phone || d.email || "New message";
}

exports.notifyNewMessage = onDocumentUpdated(
  {document: "chats/{chatId}", region: REGION, secrets: [VAPID_PRIVATE_KEY]},
  async (event) => {
    const before = event.data.before.data() || {}, after = event.data.after.data() || {};
    const t = millis(after.lastMessageAt);
    if (!t || t === millis(before.lastMessageAt)) return;            // not a new message (typing, read ticks, ...)
    const sender = after.lastSender;
    if (!sender) return;
    const recipients = [...new Set(after.participants || [])].filter((u) => u !== sender);
    if (!recipients.length) return;                                   // chat with yourself: never notify

    webpush.setVapidDetails("https://emaindi.vercel.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.value());
    const chatId = event.params.chatId;
    const last = String(after.lastMessage || "");
    const preview = !last || last.startsWith("e2e:") ? "New message" : last.slice(0, 120);

    for (const r of recipients) {
      const [name, devices] = await Promise.all([senderName(r, sender), db.collection(`users/${r}/devices`).get()]);
      await Promise.all(devices.docs.map(async (d) => {
        const dev = d.data();
        if (!dev.sub) return;
        const locked = (dev.locked || []).includes(chatId);           // locked chats show no name or text
        const payload = JSON.stringify({
          title: locked ? "emaindi" : after.isGroup === true ? String(after.name || "Group") : name,
          body: locked ? "New message" : after.isGroup === true ? name + ": " + preview : preview,
          tag: chatId,
          url: after.isGroup === true ? "chat.html?g=" + encodeURIComponent(chatId) : "chat.html?u=" + encodeURIComponent(sender),
        });
        try {
          await webpush.sendNotification(dev.sub, payload, {TTL: 86400, urgency: "high"});
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) await d.ref.delete();   // that phone unsubscribed
          else console.error("Push failed:", err.statusCode, err.body || err.message);
        }
      }));
    }
  }
);
