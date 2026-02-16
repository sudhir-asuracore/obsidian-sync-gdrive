import { requestUrl, RequestUrlParam, Notice } from 'obsidian';

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

    async createFolder(folderName: string): Promise<string> {
        this.debugLog("Creating folder", folderName);
        const data = await this.apiRequest({
            url: 'https://www.googleapis.com/drive/v3/files',
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            })
        });

        this.debugLog("Folder created", data.id);
        return data.id;
    }

    async listFiles(folderId: string): Promise<any[]> {
        const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const data = await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id, name, mimeType, modifiedTime, md5Checksum, size, version, trashed, capabilities)`,
            method: 'GET'
        });

        this.debugLog("Listed files", { folderId, count: data.files?.length || 0 });
        return data.files || [];
    }

    async findFileByName(folderId: string, name: string): Promise<any | null> {
        const query = encodeURIComponent(`'${folderId}' in parents and name = '${name}' and trashed = false`);
        const data = await this.apiRequest({
            url: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id, name, mimeType, modifiedTime, md5Checksum, size, version, trashed)`,
            method: 'GET'
        });

        const file = data.files && data.files.length > 0 ? data.files[0] : null;
        this.debugLog("Find file by name", { name, found: !!file });
        return file;
    }

    async getFileEtag(fileId: string): Promise<string | null> {
        const response = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            },
            throw: false
        });

        const headers = (response as any).headers || {};
        const etag = headers.etag || headers.ETag || null;
        this.debugLog("Fetched file ETag", { fileId, hasEtag: !!etag });
        return etag;
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

        let body;
        if (typeof content === 'string') {
            body = delimiter + metadataPart + delimiter + 'Content-Type: ' + contentType + '\r\n\r\n' + content + close_delim;
        } else {
            const decoder = new TextDecoder('utf-8');
            body = delimiter + metadataPart + delimiter + 'Content-Type: ' + contentType + '\r\n\r\n' + decoder.decode(content) + close_delim;
        }

        const headers: Record<string, string> = {
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Authorization': `Bearer ${this.accessToken}`
        };
        if (options?.ifMatch) {
            headers['If-Match'] = options.ifMatch;
        }

        const response = await requestUrl({
            url: url,
            method: method,
            headers: headers,
            body: body
        });

        if (response.status >= 400) {
            this.debugLog("Upload failed", { status: response.status, body: response.text });
            throw new Error(`Upload Error (${response.status}): ${response.text}`);
        }

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

    async downloadFile(fileId: string): Promise<ArrayBuffer> {
        this.debugLog("Downloading file", fileId);
        const response = await requestUrl({
            url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            }
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
