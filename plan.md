# Sync Drive - Obsidian Plugin Plan

## Project Overview
Sync Drive is an Obsidian plugin that allows users to sync their notes with Google Drive.

## Milestone 1: Core Functionality

### 1. Authentication
- [x] Implement Google OAuth 2.0 flow.
- [x] Securely store authentication tokens.
- [x] Provide a way for users to log in and log out.
- [x] Display logged-in user name in settings.
- [x] Toggle between Login and Logout buttons based on authentication state.
- [x] Implement bridge service for automatic redirect back to Obsidian.
- [x] Register Obsidian protocol handler (`obsidian://sync-drive`) to capture auth codes.
- [x] Fallback to manual code entry if bridge service is not configured.

### 2. Remote Storage Setup
- [x] Automatically create a folder named `obsidian_notes` in the user's Google Drive if it doesn't exist.
- [x] Ensure the plugin only interacts with this specific folder.

### 3. Sync Operations
- [x] **Force Push (Replace Remote)**: Upload all local notes to Google Drive, overwriting any existing files in `obsidian_notes`.
- [x] **Force Pull (Replace Local)**: Download all files from `obsidian_notes` and replace local notes.
- [x] **Sync**: 
    - [x] Compare local and remote file versions (e.g., using timestamps or hashes).
    - [x] Upload new/modified local files.
    - [x] Download new/modified remote files.
    - [x] Handle conflicts (basic implementation for Milestone 1).

### 4. User Interface
- [x] Add a ribbon icon for quick access to sync options.
- [x] Create a settings tab for authentication and sync status.
- [x] Display progress notifications for sync operations.

### 5. Deployment & Packaging
- [x] Add a build and package script to `package.json`.
- [x] Create a distribution folder structure suitable for Obsidian plugins.
- [x] Add a script to run the bridge service locally for testing (`npm run bridge`).

### 6. Secure Configuration
- [x] Bake Google Client ID and Secret into the plugin during build.
- [x] Use `.env` file for managing credentials during development.
- [x] Remove credential input fields from the user-facing settings tab.

## Technical Details
- **Language**: TypeScript
- **Framework**: Obsidian API
- **API**: Google Drive API v3
- **OAuth**: Google OAuth 2.0 for web applications (or limited input device if applicable, but usually web flow is preferred for Obsidian).


## Optimized Sync:
Use a meta file 'syncgdrive_meta' as a metadata store file. The file will contain tree structure that represents the folder structure of local notes. each node will contain a hashcode(light, quick hash) of the file content. 

Folder hash will be calculated by a hash of its 

Sync operation flow:
* Trigger sync
* Check if remote has 'syncgdrive_meta.json' file
* If yes, 

Meta file: Use a meta file 'syncgdrive_meta.json' as a metadata store file. When uploading data, this file needs to be updated with the list of current local files/folders and their hashcode (use a light weight and simple hash), the current timestamp.

When downloading data or performing a sync - we first download this meta file
