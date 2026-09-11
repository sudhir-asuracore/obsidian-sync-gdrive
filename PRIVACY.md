# Privacy Policy for Sync Drive

*Last updated: September 11, 2026*

**Sync Drive** ("we", "our", or "the plugin") is an open-source community plugin for Obsidian developed by Sudhir Babu Nakka. Sync Drive is designed to synchronize your personal Obsidian vault files with your personal Google Drive account.

Your privacy is paramount. Sync Drive operates as a direct client-to-cloud integration without intermediate developer servers, telemetry, or third-party data tracking.

---

## 1. Information We Access and Process

Sync Drive only accesses the information strictly required to perform synchronization functions requested by you:

- **Google Account Profile & Email:** We request access to basic profile information (such as your name and email address) via Google OAuth solely to display your logged-in status in the plugin's settings tab.
- **Google Drive Files:** We request Google Drive permissions solely to create, read, update, list, and delete files and folders inside your designated sync folder (by default `obsidian_notes/`). Sync Drive does not inspect, read, or modify files outside this designated folder.
- **Authentication Tokens:** OAuth 2.0 access tokens and refresh tokens received from Google are stored locally on your device in your Obsidian vault's plugin directory (`data.json`).
- **Vault Content:** Your Markdown notes, configuration settings, and attachments are processed locally on your device for hashing and synchronization. If client-side encryption is enabled, your notes are encrypted before being uploaded to Google Drive.

---

## 2. Google API Services User Data Policy Compliance

> **Sync Drive's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.**

Specifically:
- We do **not** transfer or disclose Google user data to any external parties.
- We do **not** use Google user data for advertising, marketing, or profiling.
- We do **not** use Google user data to train or fine-tune machine learning or artificial intelligence models.
- Human review of user data is strictly prohibited and technically impossible since we do not operate servers that receive your data.

---

## 3. Data Storage and Transmission Architecture

Sync Drive uses a **zero-server, client-only architecture**:

- **Direct Transmission:** All network requests for authentication and file operations travel directly between your local Obsidian application and Google's official API servers (`https://oauth2.googleapis.com` and `https://www.googleapis.com`) over encrypted HTTPS.
- **No Intermediate Servers:** There are no developer servers, analytics services, telemetry trackers, or third-party databases collecting or routing your data.
- **Local Storage:** All settings, cached file hashes, sync states, and OAuth tokens are stored locally on your device inside your Obsidian vault folder.

---

## 4. Client-Side Encryption

Sync Drive provides optional end-to-end client-side encryption using the industry-standard **AES-256-GCM** cipher with **PBKDF2-HMAC-SHA256** key derivation (100,000 iterations). When enabled:

- File contents are encrypted on your device before transmission to Google Drive.
- Your encryption password/key is stored only on your local device and is never sent to Google, the developer, or any remote server.
- Neither Google nor the plugin developers have access to your encryption key or decrypted note contents.

---

## 5. User Control, Data Retention, and Revocation

- **Disconnecting Account:** You can disconnect your Google account at any time by clicking "Logout" in the Sync Drive settings within Obsidian. This immediately erases your access token and refresh token from your local device.
- **Revoking Access via Google:** You can revoke Sync Drive's access to your Google account at any time via your [Google Account Security Permissions](https://myaccount.google.com/permissions).
- **Deleting Remote Data:** All synchronized files in Google Drive remain in your personal Google Drive storage and can be modified or permanently deleted by you through Google Drive at any time.

---

## 6. Security Practices

All source code for Sync Drive is open-source and publicly auditable. All network communications are conducted over Transport Layer Security (TLS/HTTPS). No passwords or unencrypted payloads are transmitted to unauthorized endpoints.

---

## 7. Changes to this Policy

If we update this Privacy Policy, changes will be published directly to this file and the hosted GitHub Pages site, and announced in the GitHub repository release notes. Continued use of the plugin following any changes constitutes acceptance of the revised policy.

---

## 8. Contact and Open Source

- **GitHub Repository:** [https://github.com/sudhir-asuracore/obsidian-sync-gdrive](https://github.com/sudhir-asuracore/obsidian-sync-gdrive)
- **Issue Tracker:** [https://github.com/sudhir-asuracore/obsidian-sync-gdrive/issues](https://github.com/sudhir-asuracore/obsidian-sync-gdrive/issues)
- **Hosted Policy:** [https://sudhir-asuracore.github.io/obsidian-sync-gdrive/privacy.html](https://sudhir-asuracore.github.io/obsidian-sync-gdrive/privacy.html)
