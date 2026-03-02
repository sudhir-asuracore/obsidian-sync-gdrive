# Sync Drive (Obsidian Plugin)

Sync Drive keeps your Obsidian vault in Google Drive with optional end-to-end encryption.

## Features
- Two-way sync between a vault and Google Drive
- Multi-vault support under a single Drive root folder
- Selective sync by file type, folder, and patterns
- Optional encryption (AES-256-GCM)
- Manual and automatic sync modes
- Optional sync of Obsidian settings (themes, snippets, plugins, hotkeys)

## Requirements
- Obsidian desktop (see Notes below)
- A Google Cloud project with the Drive API enabled
- OAuth client credentials (client ID + client secret)

## Installation (Manual)
1. Build the plugin (see Development).
2. Copy `dist/sync-drive/` into your vault at `.obsidian/plugins/sync-drive/`.
3. Enable the plugin in Obsidian settings.

## Setup
1. Create a Google Cloud project and enable the Google Drive API.
2. Create OAuth credentials (Desktop or Web app).
3. Set a redirect URI:
   - For automatic flow using the bridge: `http://localhost:8080`
   - For manual flow: leave `GOOGLE_REDIRECT_URI` unset
4. Copy `.env.sample` to `.env` and set:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI` (optional)
5. Build the plugin.

Notes:
- The OAuth client secret is embedded into the bundled `main.js` at build time. Do not publish builds that contain secrets you do not intend to share.
- For a public release, consider switching to a PKCE flow or a backend token exchange service.

## Usage
1. Open Obsidian settings -> Sync Drive.
2. Log in to Google.
3. Choose or type a vault name.
4. Click "Sync now", or enable auto sync.

### Vaults
Sync Drive creates a root folder in Google Drive named `obsidian_notes`.
Each vault you create or select becomes a subfolder under that root.

If a sync conflict happens, the local file is renamed to:
`<filename> (conflict copy: local).ext`
and the remote version is downloaded.

## Data Flow (High Level)
1. Local scan builds a file list with hashes, sizes, and timestamps.
2. Remote metadata (`metadata.json`) is loaded from Drive.
3. A diff is computed:
   - Renames
   - Uploads
   - Downloads
   - Deletes
   - Conflicts
4. Changes are applied to local and remote.
5. Metadata is updated and uploaded to Drive.

## Storage Layout
### Google Drive
- `obsidian_notes/` (root folder)
  - `<vault-name>/` (one folder per vault)
    - `metadata.json` (sync state)
    - `<your files and folders>`
  - `vaults-meta.json` (list of vaults)

### Local (inside the vault)
Stored in `.obsidian/plugins/sync-drive/`:
- `data.json` (plugin settings)
- `local-state-<hash>.json` (per-vault state)
- `local-hash-cache-<hash>.json` (hash cache)
- `autosync-delta-<hash>.json` (delta list)
- `vaults-meta-local-<hash>.json` (cached vault list)

## Encryption
When an encryption key is provided, file contents are encrypted before upload
and decrypted after download.

- Cipher: AES-256-GCM
- Key derivation: PBKDF2-HMAC-SHA256
- PBKDF2 iterations: 100,000
- Salt: 16 bytes (random per file)
- IV: 12 bytes (random per file)
- Auth tag: 16 bytes
- Header: `SDENC1` (used to identify encrypted payloads)

An `encrypt_tester` field is stored in `metadata.json` to detect key mismatches.

What is encrypted:
- File contents only

What is not encrypted:
- File names and paths
- `metadata.json` contents (except for `encrypt_tester`)
- `vaults-meta.json`

## Settings Reference
- Vault name: the name of the vault folder in Drive
- Encryption key: enables/disables encryption
- Auto sync: schedule interval sync
- Selective sync: images, audio, videos, PDFs
- Excluded folders / patterns: skip by folder or glob/regex
- Settings sync: themes, snippets, plugins, hotkeys, appearance

## Development
Prerequisites: Node.js 18+ recommended

Common commands:
```
npm install
npm run dev
npm run build
npm run package
npm run bridge
```

Build outputs:
- `main.js` is the bundled plugin entry
- `dist/sync-drive/` contains `main.js`, `manifest.json`, `styles.css`

## Contributing
1. Fork the repo
2. Create a branch
3. Make changes with clear commits
4. Open a pull request

Please include:
- A clear description of the change
- Any relevant screenshots/logs
- Notes about backwards compatibility

## Request on Commercial Use
This project is MIT-licensed. We kindly ask that you do not sell this software
or repackage it for commercial resale. If you have a commercial use case,
please open an issue to discuss.

## Notes on Obsidian Compatibility
This plugin uses the WebCrypto API for encryption, which is available on both
desktop and mobile builds of Obsidian. If WebCrypto is not available for any
reason, encryption features will fail with an explicit error.
