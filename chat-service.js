// chat-service.js

import {
  auth,
  db,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "fire.js";

// -----------------------------------------------
// 1. CREATE OR UPDATE USER PROFILE
// -----------------------------------------------

export async function createUserProfile(user, name = "") {
  if (!user) {
    throw new Error("You must log in first.");
  }

  const userRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(userRef);

  if (snapshot.exists()) {
    return snapshot;
  }

  await setDoc(userRef, {
    uid: user.uid,
    name: name || user.displayName || "",
    email: user.email || "",
    phone: user.phoneNumber || "",
    photoUrl: user.photoURL || "",
    createdAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
  });

  return await getDoc(userRef);
}

// -----------------------------------------------
// 2. UPDATE PROFILE
// -----------------------------------------------

export async function updateUserProfile(updates) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please log in first.");
  }

  const allowed = {};

  if (typeof updates.name === "string") {
    allowed.name = updates.name.trim();
  }

  if (typeof updates.photoUrl === "string") {
    allowed.photoUrl = updates.photoUrl;
  }

  if (Object.keys(allowed).length === 0) {
    throw new Error("No valid profile changes were provided.");
  }

  await updateDoc(doc(db, "users", user.uid), allowed);
}

// -----------------------------------------------
// 3. FIND USERS
// -----------------------------------------------

export function listenForUsers(callback, onError = console.error) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error("Please log in first.");
  }

  const usersQuery = query(
    collection(db, "users"),
    orderBy("name")
  );

  return onSnapshot(
    usersQuery,
    (snapshot) => {
      const users = snapshot.docs
        .map((item) => ({
          id: item.id,
          ...item.data(),
        }))
        .filter((user) => user.uid !== currentUser.uid);

      callback(users);
    },
    onError
  );
}

// -----------------------------------------------
// 4. CREATE A PRIVATE CHAT
// -----------------------------------------------

export async function startPrivateChat(otherUserId) {
  const currentUser = auth.currentUser;

  if (!currentUser) {
    throw new Error("Please log in first.");
  }

  if (!otherUserId || otherUserId === currentUser.uid) {
    throw new Error("Choose another user to start a chat.");
  }

  // Sort the UIDs so both users derive the same chat ID.
  const participants = [
    currentUser.uid,
    otherUserId,
  ].sort();

  const chatId = `${participants[0]}_${participants[1]}`;

  const chatRef = doc(db, "chats", chatId);
  const chatSnapshot = await getDoc(chatRef);

  if (!chatSnapshot.exists()) {
    await setDoc(chatRef, {
      participants,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
    });
  } else {
    const existing = chatSnapshot.data();

    if (
      !Array.isArray(existing.participants) ||
      !participants.every((uid) =>
        existing.participants.includes(uid)
      ) ||
      existing.participants.length !== 2
    ) {
      throw new Error("This chat ID is invalid.");
    }
  }

  return chatId;
}

// -----------------------------------------------
// 5. LISTEN TO THE CURRENT USER'S CHATS
// -----------------------------------------------

export function listenForMyChats(callback, onError = console.error) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please log in first.");
  }

  const chatsQuery = query(
    collection(db, "chats"),
    where("participants", "array-contains", user.uid)
  );

  return onSnapshot(
    chatsQuery,
    (snapshot) => {
      const chats = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      }));

      // Sort client-side so a composite index isn't required
      // for this particular query.
      chats.sort((a, b) => {
        const aTime = a.lastMessageAt?.toMillis?.() || 0;
        const bTime = b.lastMessageAt?.toMillis?.() || 0;

        return bTime - aTime;
      });

      callback(chats);
    },
    onError
  );
}

// -----------------------------------------------
// 6. SEND A TEXT MESSAGE
// -----------------------------------------------

export async function sendMessage(chatId, text) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please log in first.");
  }

  const messageText = text.trim();

  if (!messageText) {
    throw new Error("Message cannot be empty.");
  }

  if (messageText.length > 5000) {
    throw new Error("Message must be 5000 characters or fewer.");
  }

  const chatRef = doc(db, "chats", chatId);
  const chatSnapshot = await getDoc(chatRef);

  if (!chatSnapshot.exists()) {
    throw new Error("This conversation does not exist.");
  }

  const chat = chatSnapshot.data();

  if (!chat.participants?.includes(user.uid)) {
    throw new Error("You are not a participant in this conversation.");
  }

  const messageRef = collection(
    db,
    "chats",
    chatId,
    "messages"
  );

  const newMessage = await addDoc(messageRef, {
    senderId: user.uid,
    text: messageText,
    type: "text",
    createdAt: serverTimestamp(),
  });

  await updateDoc(chatRef, {
    lastMessage: messageText,
    lastMessageAt: serverTimestamp(),
  });

  return newMessage.id;
}

// -----------------------------------------------
// 7. LISTEN TO MESSAGES IN A CHAT
// -----------------------------------------------

export function listenForMessages(
  chatId,
  callback,
  onError = console.error
) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please log in first.");
  }

  const chatRef = doc(db, "chats", chatId);

  // Check membership before attaching the listener.
  return onSnapshot(
    chatRef,
    (chatSnapshot) => {
      if (!chatSnapshot.exists()) {
        onError(new Error("Conversation not found."));
        return;
      }

      if (!chatSnapshot.data().participants?.includes(user.uid)) {
        onError(new Error("You cannot access this conversation."));
        return;
      }

      const messagesQuery = query(
        collection(db, "chats", chatId, "messages"),
        orderBy("createdAt", "asc")
      );

      // Replace the old message listener when necessary.
      // The returned unsubscribe function is stored below.
      if (unsubscribeMessages) {
        unsubscribeMessages();
      }

      unsubscribeMessages = onSnapshot(
        messagesQuery,
        (snapshot) => {
          callback(
            snapshot.docs.map((item) => ({
              id: item.id,
              ...item.data(),
            }))
          );
        },
        onError
      );
    },
    onError
  );
}