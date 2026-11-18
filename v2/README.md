# Emaindi v2 (safe rebuild)

This is a parallel rebuild on the `rebuild-v2` branch. The existing root application remains unchanged while this version is developed.

## Data safety

- Uses the existing Firebase project imported from `../fire.js`.
- Reads existing `users/{uid}`, `chats/{chatId}`, and `chats/{chatId}/messages` documents.
- Does not clear, migrate, rename, or bulk-write existing chat data.
- A profile is created with merge semantics only when the user profile document is missing.
- Existing chat IDs follow the current app convention: sorted UIDs joined with an underscore.

## Current foundation

- Existing-account email/password sign-in and account creation.
- Google sign-in.
- Phone OTP sign-in.
- Realtime chat-list listener with explicit cache/server sync status.
- Existing conversation open and realtime message listener.
- Text message send using the current Firestore message fields.
- Responsive desktop/mobile layout and visible sync errors.

## Preview

After deploying this branch to a preview environment, open `/v2/login.html`. Do not replace the production entry point until the preview is tested with the user's existing account and existing chat history.

## Remaining rebuild work

Profile editing/photo upload, message media and voice notes, voice calling, push notifications, privacy settings, chat pin/lock, and offline message queue should be added and tested individually before production cutover.
