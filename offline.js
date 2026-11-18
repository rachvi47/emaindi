// offline.js - per-account IndexedDB cache for recent chat history and media.
// Firebase Firestore persistence remains the source of truth and queues offline writes.
const DB_NAME = "emaindi-offline-v1";
const DB_VERSION = 1;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_CHAT_CACHE_BYTES = 20 * 1024 * 1024;

let dbPromise;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", {keyPath: "key"});
        store.createIndex("chatKey", "chatKey", {unique: false});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open offline storage"));
    req.onblocked = () => console.warn("Offline storage upgrade is blocked by another tab.");
  });
  return dbPromise;
}

const chatKey = (uid, cid) => uid + "::" + cid;
const timestampMs = (v) => v && typeof v.toMillis === "function" ? v.toMillis() : Number(v || 0);
const timestamp = (n) => n ? {toMillis: () => n} : null;

export async function readChatMessages(uid, cid) {
  if (!uid || !cid || !("indexedDB" in window)) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const req = tx.objectStore("messages").index("chatKey").getAll(chatKey(uid, cid));
    req.onsuccess = () => {
      const rows = (req.result || []).map(({key, chatKey: ck, createdAtMs, ...m}) => ({...m, createdAt: timestamp(createdAtMs)}));
      rows.sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveChatMessages(uid, cid, messages) {
  if (!uid || !cid || !("indexedDB" in window)) return;
  const ordered = [...messages].sort((a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt));
  const selected = ordered.slice(-MAX_MESSAGES_PER_CHAT);
  // Keep a bounded recent window. Large image/voice payloads count toward the same budget.
  let bytes = 0;
  const bounded = [];
  for (let i = selected.length - 1; i >= 0; i--) {
    const m = selected[i];
    const rowBytes = new Blob([JSON.stringify(m)]).size;
    if (bounded.length && bytes + rowBytes > MAX_CHAT_CACHE_BYTES) continue;
    const {createdAt, ...plain} = m;
    bounded.push({key: uid + "::" + cid + "::" + m.id, chatKey: chatKey(uid, cid), createdAtMs: timestampMs(createdAt), ...plain});
    bytes += rowBytes;
  }
  bounded.reverse();
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const req = store.index("chatKey").openCursor(IDBKeyRange.only(chatKey(uid, cid)));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else bounded.forEach((row) => store.put(row));
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Could not save offline messages"));
    tx.onabort = () => reject(tx.error || new Error("Offline message cache was aborted"));
  });
}

export async function clearAccountOfflineMessages(uid) {
  if (!uid || !("indexedDB" in window)) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (cursor.value.key.startsWith(uid + "::")) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function offlineStorageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  return navigator.storage.estimate();
}

export async function offlineCacheStats(uid) {
  if (!uid || !("indexedDB" in window)) return {count: 0, bytes: 0};
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const req = tx.objectStore("messages").index("chatKey").openCursor();
    let count = 0, bytes = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (cursor.value.key.startsWith(uid + "::")) {
        count++;
        try { bytes += new Blob([JSON.stringify(cursor.value)]).size; } catch (e) {}
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve({count, bytes});
    tx.onerror = () => reject(tx.error);
  });
}
