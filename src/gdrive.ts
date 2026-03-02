import { requestUrl, RequestUrlParam } from 'obsidian';

export interface GoogleTokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
}

export class GDriveHelper {
    private accessToken: string;
    private refreshToken: string;
    private debugEnabled = false;
    private folderPathCache = new Map<string, string>();

    constructor(accessToken: string, refreshToken: string) {
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
    }

    setDebugEnabled(enabled: boolean) {
        this.debugEnabled = enabled;
    }

    private debugLog(message: string, ...args: any[]) {
        if (this.debugEnabled) {
            console.log(`[GDrive] ${message}`, ...args);
        }
    }

    setTokens(accessToken: string, refreshToken: string) {
        this.accessToken = accessToken;
        if (refreshToken) this.refreshToken = refreshToken;
        this.debugLog("Tokens updated", {
            hasAccessToken: !!this.accessToken,
            hasRefreshToken: !!this.refreshToken
        });
    }

    async refreshAccessToken(): Promise<string> {
        if (!this.refreshToken) {
            throw new Error("No refresh token available");
        }

        this.debugLog("Refreshing access token", {
            hasClientId: !!process.env.GOOGLE_CLIENT_ID,
            hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET
        });
        const response = await requestUrl({
            url: 'https://oauth2.googleapis.com/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `client_id=${process.env.GOOGLE_CLIENT_ID}&client_secret=${process.env.GOOGLE_CLIENT_SECRET}&refresh_token=${this.refreshToken}&grant_type=refresh_token`
        });

        if (response.status !== 200) {
            this.debugLog("Refresh token failed", { status: response.status, body: response.text });
            throw new Error(`Failed to refresh token: ${response.text}`);
        }

        const data: GoogleTokenResponse = response.json;
        this.accessToken = data.access_token;
        this.debugLog("Access token refreshed");
        return this.accessToken;
    }

    async apiRequest(params: RequestUrlParam, retry = true): Promise<any> {
        if (!params.headers) params.headers = {};
        params.headers['Authorization'] = `Bearer ${this.accessToken}`;

        if (params.throw === undefined) {
            params.throw = false;
        }

        const headerKeys = Object.keys(params.headers || {});
        this.debugLog("API request", { method: params.method, url: params.url, retry, headerKeys });
        const response = await requestUrl(params);

        if (response.status === 401 && retry && this.refreshToken) {
            this.debugLog("Received 401, attempting token refresh");
            await this.refreshAccessToken();
            return this.apiRequest(params, false);
        }

        if (response.status >= 400) {
            this.debugLog("API error response", { status: response.status, body: response.text });
            throw new Error(`Google API Error (${response.status}): ${response.text}`);
        }

        this.debugLog("API response ok", { status: response.status });
        return response.json;
    }

    private async requestUrlWithAuth(params: RequestUrlParam, retry = true): Promise<any> {
        if (!params.headers) params.headers = {};
        params.headers['Authorization'] = `Bearer ${this.accessToken}`;
        if (params.throw === undefined) {
            params.throw = false;
        }

        const response = await requestUrl(params);
        if (response.status === 401 && retry && this.refreshToken) {
            this.debugLog("Received 401, attempting token refresh");
            await this.refreshAccessToken();
            return this.requestUrlWithAuth(params, false);
        }

        if (response.status >= 400) {
            this.debugLog("API error response", { status: response.status, body: response.text });
            throw new Error(`Google API Error (${response.status}): ${response.text}`);
        }

        return response;
    }

    async getFolderId(folderName: string): Promise<string | null> {
        const query = encodeURIComponent(`name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        try {
            this.debugLog("Finding folder by name", folderName);
            const data = await this.apiRequest({
                url: `https://www.googleapis.com/drive/v3/files?q=${query}`,
                method: 'GET'
            });

            if (data.files && data.files.length > 0) {
                this.debugLog("Folder found", data.files[0].id);
                return data.files[0].id;
            }
        } catch (e) {
            console.warn("Failed to get folder ID:", e);
        }
        this.debugLog("Folder not found");
        return null;
    }

    async getFolderIdInParent(parentId: string, folderName: string): Promise<string | null> {
        const query = encodeURIComponent(`'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        try {
            this.debugLog("Finding folder by name in parent", { folderName, parentId });
            const data = await this.apiRequest({
                url: `https://www.googleapis.com/drive/v3/files?q=${query}`,
                method: 'GET'
            });

            if (data.files && data.files.length > 0) {
                this.debugLog("Folder found in parent", data.files[0].id);
                return data.files[0].id;
            }
        } catch (e) {
            console.warn("Failed to get folder ID in parent:", e);
        }
        this.debugLog("Folder not found in parent");
        return null;
    }

    async createFolder(folderName: string, parentId?: string): Promise<string> {
        this.debugLog("Creating folder", { folderName, parentId });
        const data = await this.apiRequest({
            url: 'https://www.googleapis.com/drive/v3/files',
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: parentId ? [parentId] : undefined
            })
        });

        this.debugLog("Folder created", data.id);
        return data.id;
    }

    async listFiles(folderId: string): Promise<any[]> {
        const files: any[] = [];
        let pageToken: string | undefined;
        const baseQuery = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        do {
            const tokenPart = pageToken ? `&pageToken=${pageToken}` : '';
            const data = await this.apiRequest({
                url: `https://www.googleapis.com/drive/v3/files?q=${baseQuery}&pageSize=1000${tokenPart}&fields=nextPageToken,files(id, name, mimeType, modifiedTime, md5Checksum, size, version, trashed, capabilities, parents)`,
                method: 'GET'
            });

            if (data.files && data.files.length > 0) {
                files.push(...data.files);
            }
            pageToken = data.nextPageToken || undefined;
        } while (pageToken);

        this.debugLog("Listed files", { folderId, count: files.length });
        return files;
    }

    async listFilesRecursive(rootFolderId: string): Promise<any[]> {
        const results: any[] = [];
        const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: '' }];

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) break;
            const children = await this.listFiles(current.id);
            for (const child of children) {
                if (child.mimeType === 'application/vnd.google-apps.folder') {
                    const childPath = current.path ? `${current.path}${child.name}/` : `${child.name}/`;
                    queue.push({ id: child.id, path: childPath });
                } else {
                    const filePath = current.path ? `${current.path}${child.name}` : child.name;
                    results.push({ ...child, path: filePath, parentId: current.id });
                }
            }
        }

        this.debugLog("Listed files recursively", { rootFolderId, count: results.length });
        return results;
    }

    async findFileByName(folderId: string, name: string): Promise<any | null> {
        const files = await this.findFilesByName(folderId, name);
        const file = files.length > 0 ? files[0] : null;
        this.debugLog("Find file by name", { name, found: !!file });
        return file;
    }

    async findFilesByName(folderId: string, name: string): Promise<any[]> {
        const query = encodeURIComponent(`'${folderId}' in parents and name = '${name}' and trashed = false`);
        const data = await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id, name, mimeType, modifiedTime, md5Checksum, size, version, trashed)`,
            method: 'GET'
        });

        const files = data.files || [];
        this.debugLog("Find files by name", { name, count: files.length });
        return files;
    }

    async ensureFolderPath(rootFolderId: string, folderPath: string): Promise<string> {
        const normalized = folderPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!normalized) return rootFolderId;

        let currentId = rootFolderId;
        let currentPath = '';
        const parts = normalized.split('/').filter(Boolean);
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const cacheKey = `${rootFolderId}:${currentPath}`;
            const cached = this.folderPathCache.get(cacheKey);
            if (cached) {
                currentId = cached;
                continue;
            }

            let nextId = await this.getFolderIdInParent(currentId, part);
            if (!nextId) {
                nextId = await this.createFolder(part, currentId);
            }
            this.folderPathCache.set(cacheKey, nextId);
            currentId = nextId;
        }

        return currentId;
    }

    async uploadFileByPath(
        rootFolderId: string,
        fullPath: string,
        content: string | ArrayBuffer,
        existingFileId?: string,
        options?: { ifMatch?: string; mimeType?: string }
    ): Promise<{ id: string; parentId: string; name: string }> {
        const normalized = fullPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const lastSlash = normalized.lastIndexOf('/');
        const folderPath = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
        const name = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
        const parentId = await this.ensureFolderPath(rootFolderId, folderPath);
        const id = await this.uploadFile(name, content, parentId, existingFileId, options);
        return { id, parentId, name };
    }

    async moveFile(fileId: string, newName: string, newParentId: string, oldParentId?: string): Promise<void> {
        const params: string[] = [];
        if (newParentId) params.push(`addParents=${encodeURIComponent(newParentId)}`);
        if (oldParentId) params.push(`removeParents=${encodeURIComponent(oldParentId)}`);
        const query = params.length > 0 ? `?${params.join('&')}` : '';

        await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}${query}`,
            method: 'PATCH',
            contentType: 'application/json',
            body: JSON.stringify({ name: newName })
        });
    }

    async uploadFile(
        name: string,
        content: string | ArrayBuffer,
        parentId: string,
        existingFileId?: string,
        options?: { ifMatch?: string; mimeType?: string }
    ): Promise<string> {
        this.debugLog("Uploading file", { name, parentId, existingFileId });
        const metadata = {
            name: name,
            parents: existingFileId ? undefined : [parentId]
        };

        const url = existingFileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

        const method = existingFileId ? 'PATCH' : 'POST';

        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";

        const contentType = options?.mimeType || 'text/markdown'; // Default for Obsidian
        const metadataPart = 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata);

        let body: string | ArrayBuffer;
        if (typeof content === 'string') {
            body = delimiter + metadataPart + delimiter + 'Content-Type: ' + contentType + '\r\n\r\n' + content + close_delim;
        } else {
            const encoder = new TextEncoder();
            const preamble = delimiter + metadataPart + delimiter + 'Content-Type: ' + contentType + '\r\n\r\n';
            const preBytes = encoder.encode(preamble);
            const postBytes = encoder.encode(close_delim);
            const contentBytes = new Uint8Array(content);
            const bodyBytes = new Uint8Array(preBytes.length + contentBytes.length + postBytes.length);
            bodyBytes.set(preBytes, 0);
            bodyBytes.set(contentBytes, preBytes.length);
            bodyBytes.set(postBytes, preBytes.length + contentBytes.length);
            body = bodyBytes.buffer;
        }

        const headers: Record<string, string> = {
            'Content-Type': `multipart/related; boundary=${boundary}`
        };
        if (options?.ifMatch) {
            headers['If-Match'] = options.ifMatch;
        }

        const response = await this.requestUrlWithAuth({
            url: url,
            method: method,
            headers: headers,
            body: body
        });

        this.debugLog("Upload success", response.json.id);
        return response.json.id;
    }

    async updateFileMetadata(fileId: string, metadata: Record<string, any>): Promise<void> {
        this.debugLog("Updating file metadata", { fileId, keys: Object.keys(metadata) });
        await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
            method: 'PATCH',
            contentType: 'application/json',
            body: JSON.stringify(metadata)
        });
    }

    async getFileMetadata(fileId: string): Promise<any> {
        this.debugLog("Getting file metadata", fileId);
        return await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id, name, mimeType, trashed`,
            method: 'GET'
        });
    }

    async getFileParents(fileId: string): Promise<string[]> {
        this.debugLog("Getting file parents", fileId);
        const data = await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
            method: 'GET'
        });
        return data?.parents || [];
    }

    async getFileVersion(fileId: string): Promise<string | null> {
        try {
            this.debugLog("Getting file version", fileId);
            const data = await this.apiRequest({
                url: `https://www.googleapis.com/drive/v3/files/${fileId}?fields=version`,
                method: 'GET'
            });
            return data?.version ? String(data.version) : null;
        } catch (e) {
            this.debugLog("Failed to get file version", e);
            return null;
        }
    }

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        this.debugLog("Downloading file", fileId);
        const response = await this.requestUrlWithAuth({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            method: 'GET'
        });

        this.debugLog("Download response", { status: response.status });
        return response.arrayBuffer;
    }

    async deleteFile(fileId: string): Promise<void> {
        this.debugLog("Deleting file", fileId);
        await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
            method: 'DELETE'
        });
    }

    async getUserInfo(): Promise<{ displayName?: string; emailAddress?: string }> {
        try {
            this.debugLog("Fetching user info");
            const data = await this.apiRequest({
                url: 'https://www.googleapis.com/oauth2/v3/userinfo',
                method: 'GET'
            });
            return {
                displayName: data.name,
                emailAddress: data.email
            };
        } catch (e) {
            console.warn("Failed to get user info:", e);
            return {};
        }
    }
}
