# hob for Android and iPhone

An Expo / React Native companion for your own hob instance. Connection setup, secure device login, the photo/camera/file picker, notifications, and file sharing are native. The complete hob workspace runs in a same-instance WebView, so bots, chat, library, settings, skills, memories, providers, browser, and automation use the existing application.

Deploy the backend and web changes in this checkout before connecting. The app checks `/api/mobile/discovery` for hob protocol 1 before asking for a password. Use the final HTTPS origin, for example `https://hob.example.com`, without a path. Reverse proxies must allow 8 MB upload request bodies. Development builds additionally accept HTTP loopback and the Android emulator's `10.0.2.2`; use HTTPS for a physical phone.

## Prepare a new Expo project

Use Node 24.21 or another Node version supported by this repository. From `mobile/`:

```sh
npm ci
npm run typecheck
npm test
npx expo install --check
npm run bundle:check
npx eas-cli@latest login
npx eas-cli@latest init
```

Sign in with your own Expo account and choose to create a new project. This repository has no pre-existing EAS project or signing credentials. Because the Expo config is dynamic, EAS may print a project ID and ask you to add it manually. Put that public UUID in `project.config.json` as `projectId`; set `owner` to your Expo account/organization name. Choose your Android package and iOS bundle identifier in that same file **before the first signed build**. The prepared defaults are `app.hob.mobile` on both platforms. These identifiers are public and can be committed.

`EXPO_PUBLIC_EAS_PROJECT_ID`, `HOB_ANDROID_PACKAGE`, and `HOB_IOS_BUNDLE_ID` can override the public file. When using overrides, supply the same values locally and in the EAS build environment. Do not put passwords, provider API keys, or signing credentials in the public configuration.

## Build and install

The checked-in `eas.json` provides development, internal preview, and production profiles:

For an account-free Android test, the **Mobile app validation → android-preview** CI job also produces a `hob-android-preview` artifact containing an installable arm64 APK. It bundles the workspace shell, uses a generated debug signing key, and needs no Metro server. Its default configuration has no EAS project or Firebase credentials, so use an EAS build configured below to test push. The preview certificate is for testing; build with your own credentials for distribution.

```sh
# Installable Android APK
npx eas-cli@latest build --profile preview --platform android

# Internal iPhone build, using your Apple Developer account and registered devices
npx eas-cli@latest device:create
npx eas-cli@latest build --profile preview --platform ios

# Development clients, then start Metro for iteration
npx eas-cli@latest build --profile development --platform all
npm start

# Store builds when ready for release
npx eas-cli@latest build --profile production --platform all
```

EAS can manage the Android keystore and Apple signing/provisioning interactively. Local `npm run android` needs Android Studio/JDK; `npm run ios` needs macOS/Xcode. A JavaScript bundle export does not produce an APK or IPA. CI validates both platform bundles without signing into an account.

## Configure push delivery

Push is optional. Login and the workspace work without it. Use a signed development or preview build on a physical phone; this app intentionally requires a physical device when registering notifications.

1. Link the EAS project as above.
2. For Android, create a Firebase project and Android app matching `androidPackage`. Add its `google-services.json` through an EAS **file** environment variable named `GOOGLE_SERVICES_JSON` in each build environment you use. Upload the matching FCM v1 service-account credential through `npx eas-cli@latest credentials --platform android`.
3. For iOS, configure APNs with your Apple Developer account through `npx eas-cli@latest credentials --platform ios`.
4. Rebuild after configuring platform credentials. In the installed app, open **Connection → Enable notifications**, grant the OS permission, and use **Send a test notification**. Background the app and complete a real Hermes reply; tapping the alert opens its bot and conversation.

Follow the current [Expo push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/) and [EAS build setup](https://docs.expo.dev/build/setup/) for the account-specific steps. If enhanced Expo push security is enabled, set `HOB_EXPO_ACCESS_TOKEN` **on the hob server**, using Coolify's secret/environment settings. The Compose file passes it to the server. It never belongs in the mobile app.

The instance queues completed native Hermes replies, including observed background work, once per admission and device. The outbox survives restarts and checks Expo delivery receipts. Notifications contain a generic “Main has a new reply” message plus routing IDs; chat text, attachments, passwords, and model keys are not sent to Expo. Foreground reply banners are suppressed; test banners remain visible. A successful receipt means the push provider accepted the alert, not that a person read it. OpenClaw compatibility mode does not emit Hermes reply alerts.

## Media and sessions

- Tap the paperclip for photos/videos, camera, or files. Attachment cards appear above the text field and expand the composer. Remove a card before sending or send attachments without typing.
- Up to 10 attachments, each at most 5 MB. Photos selected from the media library are converted to JPEG and resized to at most 2048 pixels. Documents and videos retain their bytes. Unsupported/oversized files show an error. A model's ability to interpret a document or video still depends on its tools and capabilities.
- Files are staged through Hermes' own session attachment methods. Signed upload references are bound to the conversation and expire after 30 minutes; reattach an expired draft. Uploads use the owning bot even if you switch views while the picker is open.
- Image and library download actions open the phone's native share/save sheet. Authenticated downloads stay on the connected instance and are limited to 25 MB.
- The password is used only for login. A hashed server-side device token is stored in iOS Keychain / Android encrypted storage, expires after 30 days, and bootstraps a short-lived HttpOnly workspace cookie. Changing the instance password invalidates existing device sessions.
- **Disconnect this device** revokes its server session and queued notifications, then clears local storage. It needs the server to answer; if offline, reconnect and disconnect again. Revocation prevents future queued sends; an alert already handed to the push provider may still arrive.

## Verification still needed on your instance

Account-free checks cover URL/identity validation, session revocation, cross-instance notification routing, native attachment staging, notification deduplication/retries, types, and Android/iOS JavaScript bundles. Before distribution, install the signed builds on Android and iPhone and verify real login, background/terminated-app notifications, notification taps, camera/library/files, attachment removal and sending, keyboard layout, downloads, reconnect, and sign-out against your deployed hob instance. APNs/FCM delivery and OS permission behavior require those builds and credentials.
