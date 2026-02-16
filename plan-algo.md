# Sync Algorithm Design

## 1. Metadata Structure (`metadata.json`)

The metadata file acts as the source of truth for the state of the remote folder. It reduces the need to recursively list remote files, which is an expensive operation. It should include enough information to detect renames, avoid clock-skew bugs, and support safe concurrency.

```json
{
  "schemaVersion": 1,
  "rootFolderId": "gdrive_folder_id",
  "lastSyncTimestamp": 1678900000,
  "lastSyncByDevice": "device_id_optional",
  "files": {
    "folder/file.txt": {
      "id": "gdrive_file_id",
      "hash": "md5_hash_string",
      "modifiedTime": 1678900000,
      "size": 1024,
      "isDeleted": false,
      "mimeType": "text/plain",
      "version": 12
    }
  }
}
```

Notes:
- `id` enables rename/move detection and prevents duplicate-name ambiguity.
- `version` (Drive file version) helps detect changes when `md5Checksum` is missing (e.g., Google Docs).
- `lastSyncTimestamp` should reflect server time (or metadata modified time), not the local clock.

## 1.1 Local State Cache (`local-state.json`)

Keep a local cache to support three-way diff and avoid deleting or uploading based on only current timestamps.

```json
{
  "schemaVersion": 1,
  "lastSyncTimestamp": 1678900000,
  "files": {
    "folder/file.txt": {
      "hash": "md5_hash_string",
      "modifiedTime": 1678900000,
      "size": 1024
    }
  }
}
```

This cache tracks the last known synced state for this device (the merge base).

## 2. Sync Workflow

The sync process consists of three main phases: **Fetch & Compare**, **Apply Changes**, and **Commit**.

### Phase 1: Fetch & Compare

1.  **Lock**: Acquire a local lock to prevent concurrent syncs.
2.  **Fetch Remote Metadata**:
    *   Download `metadata.json` from Google Drive.
    *   If it doesn't exist, assume remote is empty or initialize a new metadata structure.
    *   *Optimization*: Use `If-None-Match` with ETag to avoid downloading if unchanged.
3.  **Load Local State Cache**:
    *   Read `local-state.json` if present; if missing, treat as first sync on this device.
4.  **Scan Local Files**:
    *   Traverse the local vault.
    *   Calculate hashes (MD5) and modification times for all local files.
    *   *Optimization*: Maintain a local database/cache of hashes. Only re-calculate hash if `mtime` or `size` has changed since last local scan.
5.  **Diff Generation** (three-way):
    *   Compare Local Current vs. Remote Metadata vs. Local State Cache (merge base).
    *   **To Download**: 
        *   File exists in Remote Metadata (and `!isDeleted`) but missing locally.
        *   Remote differs from base AND Local matches base (or missing).
    *   **To Upload**: 
        *   File exists locally but missing in Remote Metadata.
        *   Local differs from base AND Remote matches base (or missing).
    *   **To Delete Locally**: 
        *   File marked `isDeleted` in Remote Metadata and exists locally.
    *   **To Delete Remotely**: 
        *   File missing locally AND file exists in Local State Cache -> Mark `isDeleted` in metadata.
    *   **Conflicts**: 
        *   If both changed relative to base (Local differs AND Remote differs).
        *   *Strategy*: **Rename Local** (e.g., `file (conflicted copy).txt`) and download Remote version.
    *   **Rename/Move Detection**:
        *   If a file `id` exists with a different path, treat as rename instead of delete+add.
    *   **Hash Fallback**:
        *   If `md5Checksum` is missing (e.g., Google Docs), compare by `version` and `modifiedTime` only.

### Phase 2: Apply Changes

1.  **Downloads**:
    *   Iterate through "To Download" list.
    *   Download file content from GDrive.
    *   Update local file.
    *   Update Local State cache (hash/mtime).
2.  **Deletions (Local)**:
    *   Delete files marked for local deletion.
3.  **Uploads**:
    *   Iterate through "To Upload" list.
    *   Upload file content to GDrive.
    *   Update entry in the *new* Metadata structure.
4.  **Deletions (Remote)**:
    *   Trash/Delete files on GDrive.
    *   Update entry in *new* Metadata as `isDeleted: true`.
5.  **Renames/Moves**:
    *   If file `id` is the same but path changed locally, issue a remote rename/move.

### Phase 3: Commit

1.  **Update Metadata**:
    *   Generate the final `metadata.json` reflecting the new state of the remote drive.
    *   Update `lastSyncTimestamp`.
2.  **Upload Metadata**:
    *   Upload `metadata.json` to Google Drive.
    *   *Critical*: Use `If-Match` header with the previous ETag/Generation number of the `metadata.json` file.
    *   **Concurrency Handling**: If upload fails (Precondition Failed / 412), it means another client synced in the meantime.
        *   **Action**: Abort current commit. Re-download new metadata. Re-run Diff Generation (Phase 1) with the new metadata.

## 3. Optimizations

*   **Hashing**: Calculate MD5 hashes for local files. Cache these hashes and only re-calculate if file modification time or size changes.
*   **Incremental Sync**: The metadata file allows us to skip listing all files on Google Drive (which is slow). We only list/get the metadata file.
*   **Batch Requests**: If the GDrive API supports it, batch upload/download requests to reduce HTTP overhead.
*   **Ignore Patterns**: Respect `.gitignore` or a custom ignore list to skip temporary files or system files (e.g., `.DS_Store`).
*   **Compression**: GZip text files before upload if bandwidth is a concern (though this complicates the "view on Drive" aspect).

## 4. Safety and Repair

*   **Clock Skew**: Prefer server-provided timestamps (metadata modified time) to local time.
*   **Partial Failure**: Only upload metadata after all file operations succeed; if failures occur, keep local-state unchanged and retry.
*   **Metadata Missing/Corrupt**: Fall back to a full remote scan to rebuild metadata (slow but safe), or prompt the user for a direction (upload local vs. download remote).
*   **Case Sensitivity**: Normalize paths on Windows to avoid collisions and ambiguous renames.
