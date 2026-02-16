import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, Platform, ObsidianProtocolData, Menu as ObsidianMenu } from 'obsidian';
import { createHash } from 'crypto';
import { GDriveHelper } from './src/gdrive';

interface SyncDriveSettings {
	accessToken: string;
	refreshToken: string;
	remoteFolderId: string;
	userName: string;
	debugLogging: boolean;
	autoSyncEnabled: boolean;
	autoSyncIntervalValue: number;
	autoSyncIntervalUnit: 'seconds' | 'minutes';
}

const DEFAULT_SETTINGS: SyncDriveSettings = {
	accessToken: '',
	refreshToken: '',
	remoteFolderId: '',
	userName: '',
	debugLogging: true,
	autoSyncEnabled: false,
	autoSyncIntervalValue: 5,
	autoSyncIntervalUnit: 'minutes'
}

interface RemoteMetadataEntry {
	id?: string;
	hash?: string;
	modifiedTime?: number;
	size?: number;
	isDeleted?: boolean;
	mimeType?: string;
	version?: number;
}

interface RemoteMetadataFile {
	schemaVersion: number;
	rootFolderId: string;
	lastSyncTimestamp: number;
	lastSyncByDevice?: string;
	files: Record<string, RemoteMetadataEntry>;
}

type LocalStateFile = RemoteMetadataFile;

interface LocalHashCacheEntry {
	hash: string;
	modifiedTime: number;
	size: number;
}

interface LocalHashCacheFile {
	schemaVersion: number;
	updatedAt: number;
	files: Record<string, LocalHashCacheEntry>;
}

interface LocalFileState {
	hash: string;
	modifiedTime: number;
	size: number;
}

interface SyncDiff {
	renameLocal: Array<{ from: string; to: string }>;
	renameRemote: Array<{ id: string; to: string }>;
	toDownload: string[];
	toUpload: string[];
	toDeleteLocal: string[];
	toDeleteRemote: string[];
	conflicts: string[];
}

export default class SyncDrivePlugin extends Plugin {
	settings!: SyncDriveSettings;
	gdrive!: GDriveHelper;
	private debugEnabled = false;
	private syncInProgress = false;
	private ribbonIconEl: HTMLElement | null = null;
	private autoSyncTimer: number | null = null;
	private deltaDirtyPaths = new Set<string>();
	private deltaFlushTimer: number | null = null;
	private deltaLoaded = false;

	debugLog(message: string, ...args: any[]) {
		if (this.debugEnabled) {
			console.log(`[SyncDrive] ${message}`, ...args);
		}
	}

	setDebugEnabled(enabled: boolean) {
		this.debugEnabled = enabled;
		if (this.gdrive) {
			this.gdrive.setDebugEnabled(enabled);
		}
	}

	private getPluginDataPath(fileName: string): string {
		const configDir = this.app.vault.configDir || '.obsidian';
		return `${configDir}/plugins/${this.manifest.id}/${fileName}`;
	}

	private async ensurePluginDataDir(): Promise<void> {
		const configDir = this.app.vault.configDir || '.obsidian';
		const dir = `${configDir}/plugins/${this.manifest.id}`;
		try {
			await this.app.vault.adapter.mkdir(dir);
		} catch (e) {
			// Ignore if already exists.
		}
	}

	private async loadLocalState(): Promise<LocalStateFile> {
		const path = this.getPluginDataPath('local-state.json');
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1 && parsed.files) {
					return parsed as LocalStateFile;
				}
			}
		} catch (e) {
			console.warn("Failed to load local state; starting fresh", e);
		}

		return {
			schemaVersion: 1,
			rootFolderId: '',
			lastSyncTimestamp: 0,
			lastSyncByDevice: '',
			files: {}
		};
	}

	private async saveLocalState(state: LocalStateFile): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath('local-state.json');
		await this.app.vault.adapter.write(path, JSON.stringify(state, null, 2));
	}

	private async loadLocalHashCache(): Promise<LocalHashCacheFile> {
		const path = this.getPluginDataPath('local-hash-cache.json');
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1 && parsed.files) {
					return parsed as LocalHashCacheFile;
				}
			}
		} catch (e) {
			console.warn("Failed to load local hash cache; starting fresh", e);
		}

		return {
			schemaVersion: 1,
			updatedAt: 0,
			files: {}
		};
	}

	private async saveLocalHashCache(cache: LocalHashCacheFile): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath('local-hash-cache.json');
		await this.app.vault.adapter.write(path, JSON.stringify(cache, null, 2));
	}

	private async loadDeltaState(): Promise<void> {
		if (this.deltaLoaded) return;
		const path = this.getPluginDataPath('autosync-delta.json');
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.paths)) {
					this.deltaDirtyPaths = new Set(parsed.paths);
				}
			}
		} catch (e) {
			console.warn("Failed to load autosync delta state", e);
		}
		this.deltaLoaded = true;
	}

	private clearDeltaFlushTimer() {
		if (this.deltaFlushTimer !== null) {
			window.clearTimeout(this.deltaFlushTimer);
			this.deltaFlushTimer = null;
		}
	}

	private scheduleDeltaFlush() {
		this.clearDeltaFlushTimer();
		this.deltaFlushTimer = window.setTimeout(() => {
			this.flushDeltaState().catch(e => console.warn("Failed to flush autosync delta state", e));
		}, 1000);
	}

	private async flushDeltaState(): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath('autosync-delta.json');
		const payload = {
			updatedAt: Date.now(),
			paths: Array.from(this.deltaDirtyPaths)
		};
		await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
	}

	private markDelta(path?: string) {
		if (path && !path.startsWith('.obsidian/')) {
			this.deltaDirtyPaths.add(path);
		}
		this.scheduleDeltaFlush();
	}

	private clearDelta() {
		this.deltaDirtyPaths.clear();
		this.scheduleDeltaFlush();
	}

	private hasLocalDelta(): boolean {
		return this.deltaDirtyPaths.size > 0;
	}

	private registerVaultChangeListeners() {
		this.registerEvent(this.app.vault.on('modify', file => this.markDelta(file?.path)));
		this.registerEvent(this.app.vault.on('create', file => this.markDelta(file?.path)));
		this.registerEvent(this.app.vault.on('delete', file => this.markDelta(file?.path)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.markDelta(oldPath);
			this.markDelta(file?.path);
		}));
	}

	private async loadRemoteMetadata(folderId: string): Promise<{ metadata: RemoteMetadataFile | null; fileId: string | null; etag: string | null }> {
		const metadataFile = await this.gdrive.findFileByName(folderId, 'metadata.json');
		if (!metadataFile) {
			return { metadata: null, fileId: null, etag: null };
		}

		const etag = await this.gdrive.getFileEtag(metadataFile.id);
		const data = await this.gdrive.downloadFile(metadataFile.id);
		const raw = new TextDecoder('utf-8').decode(data);
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.schemaVersion === 1 && parsed.files) {
				return { metadata: parsed as RemoteMetadataFile, fileId: metadataFile.id, etag: etag };
			}
		} catch (e) {
			console.warn("Failed to parse remote metadata; treating as missing", e);
		}

		return { metadata: null, fileId: metadataFile.id || null, etag: etag };
	}

	private async buildRemoteMetadataFromDrive(folderId: string): Promise<RemoteMetadataFile> {
		const remoteFiles = await this.gdrive.listFiles(folderId);
		const files: Record<string, RemoteMetadataEntry> = {};
		for (const file of remoteFiles) {
			if (file.name === 'metadata.json') continue;
			const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
			files[file.name] = {
				id: file.id,
				hash: file.md5Checksum,
				modifiedTime: modifiedTime,
				size: file.size ? Number(file.size) : undefined,
				isDeleted: false,
				mimeType: file.mimeType,
				version: file.version ? Number(file.version) : undefined
			};
		}

		return {
			schemaVersion: 1,
			rootFolderId: folderId,
			lastSyncTimestamp: 0,
			lastSyncByDevice: this.settings.userName || 'unknown',
			files: files
		};
	}

	private computeHash(content: ArrayBuffer): string {
		const hash = createHash('md5');
		hash.update(Buffer.from(content));
		return hash.digest('hex');
	}

	private async scanLocalFiles(hashCache: LocalHashCacheFile): Promise<{ files: Record<string, LocalFileState>; cache: LocalHashCacheFile }> {
		const localFiles = this.app.vault.getFiles();
		const result: Record<string, LocalFileState> = {};
		const nextCache: LocalHashCacheFile = {
			schemaVersion: 1,
			updatedAt: Date.now(),
			files: {}
		};
		for (const localFile of localFiles) {
			if (localFile.path.startsWith('.obsidian/')) continue;
			const size = localFile.stat.size;
			const modifiedTime = localFile.stat.mtime;
			const cached = hashCache.files[localFile.path];
			if (cached && cached.size === size && cached.modifiedTime === modifiedTime && cached.hash) {
				result[localFile.path] = {
					hash: cached.hash,
					modifiedTime: modifiedTime,
					size: size
				};
				nextCache.files[localFile.path] = {
					hash: cached.hash,
					modifiedTime: modifiedTime,
					size: size
				};
				continue;
			}

			const content = await this.app.vault.readBinary(localFile);
			const hash = this.computeHash(content);
			result[localFile.path] = {
				hash: hash,
				modifiedTime: modifiedTime,
				size: size
			};
			nextCache.files[localFile.path] = {
				hash: hash,
				modifiedTime: modifiedTime,
				size: size
			};
		}

		return { files: result, cache: nextCache };
	}

	private buildDiff(remote: RemoteMetadataFile, localState: LocalStateFile, localCurrent: Record<string, LocalFileState>): SyncDiff {
		const diff: SyncDiff = {
			renameLocal: [],
			renameRemote: [],
			toDownload: [],
			toUpload: [],
			toDeleteLocal: [],
			toDeleteRemote: [],
			conflicts: []
		};

		const remoteById = new Map<string, string>();
		Object.entries(remote.files).forEach(([path, entry]) => {
			if (entry.id) remoteById.set(entry.id, path);
		});

		const localStateById = new Map<string, string>();
		Object.entries(localState.files).forEach(([path, entry]) => {
			if (entry.id) localStateById.set(entry.id, path);
		});

		for (const [id, remotePath] of remoteById) {
			const localPath = localStateById.get(id);
			if (localPath && localPath !== remotePath) {
				if (localCurrent[localPath] && !localCurrent[remotePath]) {
					diff.renameLocal.push({ from: localPath, to: remotePath });
				}
			}
		}

		const localByHashSize = new Map<string, string>();
		for (const [path, entry] of Object.entries(localCurrent)) {
			const key = `${entry.hash}:${entry.size}`;
			if (localByHashSize.has(key)) {
				localByHashSize.delete(key);
			} else {
				localByHashSize.set(key, path);
			}
		}

		for (const [path, entry] of Object.entries(localState.files)) {
			if (!entry.id) continue;
			if (!localCurrent[path]) {
				const key = `${entry.hash}:${entry.size}`;
				const candidatePath = localByHashSize.get(key);
				if (candidatePath && remote.files[path] && remote.files[path].id === entry.id) {
					diff.renameRemote.push({ id: entry.id, to: candidatePath });
				}
			}
		}

		const renameLocalTargets = new Set(diff.renameLocal.map(r => r.to));
		const renameLocalSources = new Set(diff.renameLocal.map(r => r.from));

		const paths = new Set<string>([
			...Object.keys(remote.files),
			...Object.keys(localCurrent),
			...Object.keys(localState.files)
		]);

			for (const path of paths) {
				if (renameLocalSources.has(path) || renameLocalTargets.has(path)) {
					continue;
				}

			const remoteEntry = remote.files[path];
			const localEntry = localCurrent[path];
			const baseEntry = localState.files[path];

			const remoteExists = !!remoteEntry && !remoteEntry.isDeleted;
			const remoteDeleted = !!remoteEntry && remoteEntry.isDeleted;
			const localExists = !!localEntry;
			const baseExists = !!baseEntry;

			const baseHash = baseEntry?.hash;
			const baseModified = baseEntry?.modifiedTime;
			const localChanged = localExists && (!baseExists || (baseHash ? localEntry.hash !== baseHash : baseModified ? localEntry.modifiedTime !== baseModified : true));
			const remoteChanged = remoteExists && (!baseExists || (remoteEntry.hash && baseHash ? remoteEntry.hash !== baseHash : remoteEntry.modifiedTime !== baseModified));

			if (remoteDeleted && localExists) {
				diff.toDeleteLocal.push(path);
				continue;
			}

			if (!localExists && baseExists && remoteExists) {
				diff.toDeleteRemote.push(path);
				continue;
			}

			if (remoteExists && !localExists) {
				diff.toDownload.push(path);
				continue;
			}

			if (localExists && !remoteExists) {
				diff.toUpload.push(path);
				continue;
			}

			if (remoteExists && localExists) {
				const isConflict = localChanged && remoteChanged;
				let reason = 'no-change';
				if (isConflict) {
					reason = 'conflict-both-changed';
				} else if (remoteChanged && !localChanged) {
					reason = 'download-remote-changed';
				} else if (localChanged && !remoteChanged) {
					reason = 'upload-local-changed';
				}
				if (this.debugEnabled) {
					this.debugLog("Diff decision", {
						path,
						local: localEntry,
						remote: remoteEntry,
						base: baseEntry,
						conflict: isConflict,
						reason
					});
				}
				if (isConflict) {
					diff.conflicts.push(path);
				} else if (remoteChanged && !localChanged) {
					diff.toDownload.push(path);
				} else if (localChanged && !remoteChanged) {
					diff.toUpload.push(path);
				}
			}
		}

		return diff;
	}

	private getConflictPath(originalPath: string): string {
		const dot = originalPath.lastIndexOf('.');
		if (dot > 0) {
			const base = originalPath.slice(0, dot);
			const ext = originalPath.slice(dot);
			return `${base} (conflicted copy)${ext}`;
		}
		return `${originalPath} (conflicted copy)`;
	}

	async onload() {
		await this.loadSettings();
		this.setDebugEnabled(!!this.settings.debugLogging);

		this.gdrive = new GDriveHelper(
			this.settings.accessToken,
			this.settings.refreshToken
		);
		this.gdrive.setDebugEnabled(this.debugEnabled);

		this.registerObsidianProtocolHandler("sync-drive", async (data: ObsidianProtocolData) => {
			const code = data.code;
			if (code) {
				this.debugLog("Protocol handler invoked with code length", code.length);
				const clientId = process.env.GOOGLE_CLIENT_ID || "";
				const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
				const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost"; // Should match what was sent
				await this.exchangeCodeForToken(code, clientId, clientSecret, redirectUri);
			}
		});

		this.addCommand({
			id: 'sync-drive-now',
			name: 'Sync Drive: Sync Now',
			callback: async () => {
				await this.sync();
			}
		});

		this.ribbonIconEl = this.addRibbonIcon('sync', 'Sync Drive', async () => {
			await this.sync();
		});

		this.addSettingTab(new SyncDriveSettingTab(this.app, this));
		this.applyAutoSyncSettings();
		await this.loadDeltaState();
		this.registerVaultChangeListeners();

		// Initialize remote folder if authenticated
		if (this.settings.accessToken) {
			this.debugLog("Initializing remote folder on load");
			this.getRemoteFolderId().catch(e => {
				console.error("Failed to initialize remote folder on load:", e);
			});
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.gdrive) {
			this.gdrive = new GDriveHelper(
				this.settings.accessToken,
				this.settings.refreshToken
			);
			this.gdrive.setDebugEnabled(this.debugEnabled);
		}
		this.applyAutoSyncSettings();
	}

	onunload() {
		this.clearAutoSyncTimer();
		this.clearDeltaFlushTimer();
	}

	private getAutoSyncIntervalMs(): number {
		const value = Math.max(1, Number(this.settings.autoSyncIntervalValue) || 1);
		return this.settings.autoSyncIntervalUnit === 'seconds'
			? value * 1000
			: value * 60 * 1000;
	}

	private clearAutoSyncTimer() {
		if (this.autoSyncTimer !== null) {
			window.clearTimeout(this.autoSyncTimer);
			this.autoSyncTimer = null;
		}
	}

	private scheduleAutoSync() {
		this.clearAutoSyncTimer();
		if (!this.settings.autoSyncEnabled) return;

		const intervalMs = this.getAutoSyncIntervalMs();
		this.autoSyncTimer = window.setTimeout(async () => {
			if (!this.syncInProgress && this.hasLocalDelta()) {
				await this.sync('auto');
			}
			this.scheduleAutoSync();
		}, intervalMs);
	}

	private applyAutoSyncSettings() {
		if (this.settings.autoSyncEnabled) {
			this.scheduleAutoSync();
		} else {
			this.clearAutoSyncTimer();
		}
	}

	private resetAutoSyncTimer() {
		if (this.settings.autoSyncEnabled) {
			this.scheduleAutoSync();
		}
	}

	async authenticate() {
		const clientId = process.env.GOOGLE_CLIENT_ID || "";
		const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
		const redirectUri = process.env.GOOGLE_REDIRECT_URI;
		this.debugLog("Starting auth flow", {
			hasClientId: !!clientId,
			hasClientSecret: !!clientSecret,
			hasRedirectUri: !!redirectUri
		});

		if (!redirectUri) {
			new Notice("Google Redirect URI is not configured. Falling back to manual mode.");
			this.openManualAuthModal(clientId, clientSecret);
			return;
		}

		const scope = [
			'https://www.googleapis.com/auth/drive.file',
			'https://www.googleapis.com/auth/drive.metadata.readonly',
			'openid',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/userinfo.profile'
		].join(' ');
		const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

		window.open(authUrl);
		new Notice("Opening browser for authentication...");
	}

	async exchangeCodeForToken(code: string, clientId: string, clientSecret: string, redirectUri: string) {
		try {
			this.debugLog("Exchange started", { hasCode: !!code, codeLength: code.length });
			const response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_type=authorization_code`
			});
			this.debugLog("Token exchange response", { status: response.status });

			if (response.status !== 200) {
				this.debugLog("Token exchange failed body", response.text);
				throw new Error(`Token exchange failed (${response.status}): ${response.text}`);
			}

			const data = response.json;
			this.settings.accessToken = data.access_token;
			if (data.refresh_token) this.settings.refreshToken = data.refresh_token;
			this.debugLog("Token exchange success", {
				hasAccessToken: !!this.settings.accessToken,
				hasRefreshToken: !!this.settings.refreshToken,
				scope: data.scope
			});
			this.gdrive.setTokens(this.settings.accessToken, this.settings.refreshToken);
			const userInfo = await this.gdrive.getUserInfo();
			this.settings.userName = userInfo.displayName || userInfo.emailAddress || "";
			await this.saveSettings();

			new Notice(`Authenticated as ${this.settings.userName}`);

			this.debugLog("Post-auth user info set", { userName: this.settings.userName });
			await this.getRemoteFolderId();

			// Refresh settings tab if open
			(this.app as any).setting.openTabById(this.manifest.id);
		} catch (e: any) {
			new Notice(`Authentication failed: ${e.message}`);
			console.error("Token exchange error:", e);
		}
	}

	openManualAuthModal(clientId: string, clientSecret: string) {
		const manualRedirectUri = "http://localhost";
		const scope = [
			'https://www.googleapis.com/auth/drive.file',
			'https://www.googleapis.com/auth/drive.metadata.readonly',
			'openid',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/userinfo.profile'
		].join(' ');
		const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(manualRedirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

		new OAuthModal(this.app, authUrl, async (code) => {
			await this.exchangeCodeForToken(code, clientId, clientSecret, manualRedirectUri);
		}).open();
	}

	private setSyncingIndicator(active: boolean) {
		if (!this.ribbonIconEl) return;
		this.ribbonIconEl.toggleClass('sync-drive-syncing', active);
	}

	async getRemoteFolderId(): Promise<string> {
		if (!this.settings.accessToken) return "";

		if (this.settings.remoteFolderId) {
			try {
				this.debugLog("Checking existing remote folder id", this.settings.remoteFolderId);
				const folder = await this.gdrive.getFileMetadata(this.settings.remoteFolderId);
				if (folder && !folder.trashed) {
					this.debugLog("Existing remote folder id is valid");
					return this.settings.remoteFolderId;
				}
			} catch (e) {
				console.warn("Stored remote folder ID is invalid or inaccessible. Searching for folder by name.");
			}
		}

		try {
			this.debugLog("Searching for remote folder by name");
			let folderId = await this.gdrive.getFolderId('obsidian_notes');
			if (!folderId) {
				new Notice("Creating remote folder 'obsidian_notes'...");
				this.debugLog("Remote folder not found, creating");
				folderId = await this.gdrive.createFolder('obsidian_notes');
			}

			this.settings.remoteFolderId = folderId;
			await this.saveSettings();
			this.debugLog("Remote folder ready", folderId);
			return folderId;
		} catch (e) {
			console.error("Failed to get/create remote folder:", e);
			new Notice("Failed to initialize Google Drive folder. Please check connection/permissions.");
			return "";
		}
	}

	async sync(trigger: 'manual' | 'auto' = 'manual') {
		if (!this.settings.accessToken) {
			new Notice("Please authenticate in settings first.");
			return;
		}

		if (this.syncInProgress) {
			if (trigger === 'manual') {
				new Notice("Sync already in progress.");
			}
			return;
		}

		this.syncInProgress = true;
		this.setSyncingIndicator(true);
		try {
			this.debugLog("Sync started");
			const folderId = await this.getRemoteFolderId();
			if (!folderId) return;

			const remoteMetaInfo = await this.loadRemoteMetadata(folderId);
			let remoteMetadata = remoteMetaInfo.metadata;
			let metadataFileId = remoteMetaInfo.fileId;
			let metadataEtag = remoteMetaInfo.etag;

			if (!remoteMetadata) {
				this.debugLog("No remote metadata found, rebuilding from Drive listing");
				remoteMetadata = await this.buildRemoteMetadataFromDrive(folderId);
				metadataFileId = await this.gdrive.uploadFile(
					'metadata.json',
					JSON.stringify(remoteMetadata, null, 2),
					folderId,
					metadataFileId || undefined,
					{ mimeType: 'application/json' }
				);
				metadataEtag = null;
			}

			let localState = await this.loadLocalState();
			if (localState.rootFolderId && localState.rootFolderId !== folderId) {
				localState = {
					schemaVersion: 1,
					rootFolderId: folderId,
					lastSyncTimestamp: 0,
					lastSyncByDevice: '',
					files: {}
				};
			}

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache);
			let localCurrent = scan.files;
			let hashCacheState = scan.cache;

			this.debugLog("Sync file counts", {
				remote: Object.keys(remoteMetadata.files).length,
				local: Object.keys(localCurrent).length
			});

			new Notice("Syncing...");

			const diff = this.buildDiff(remoteMetadata, localState, localCurrent);

			for (const rename of diff.renameLocal) {
				const localFile = this.app.vault.getAbstractFileByPath(rename.from);
				if (localFile instanceof TFile) {
					await this.app.vault.rename(localFile, rename.to);
					localCurrent[rename.to] = localCurrent[rename.from];
					delete localCurrent[rename.from];
				}
			}

			for (const conflict of diff.conflicts) {
				const localFile = this.app.vault.getAbstractFileByPath(conflict);
				if (localFile instanceof TFile) {
					const conflictPath = this.getConflictPath(conflict);
					await this.app.vault.rename(localFile, conflictPath);
					localCurrent[conflictPath] = localCurrent[conflict];
					delete localCurrent[conflict];
				}
				diff.toDownload.push(conflict);
			}

			for (const path of diff.toDownload) {
				const remoteEntry = remoteMetadata.files[path];
				if (!remoteEntry || remoteEntry.isDeleted || !remoteEntry.id) continue;
				const content = await this.gdrive.downloadFile(remoteEntry.id);
				const localFile = this.app.vault.getAbstractFileByPath(path);
				if (localFile instanceof TFile) {
					await this.app.vault.modifyBinary(localFile, content);
				} else {
					await this.app.vault.createBinary(path, content);
				}
				const hash = remoteEntry.hash || this.computeHash(content);
				localCurrent[path] = {
					hash: hash,
					modifiedTime: remoteEntry.modifiedTime || Date.now(),
					size: remoteEntry.size || content.byteLength
				};
			}

			for (const path of diff.toDeleteLocal) {
				const localFile = this.app.vault.getAbstractFileByPath(path);
				if (localFile instanceof TFile) {
					await this.app.vault.delete(localFile);
					delete localCurrent[path];
				}
			}

			for (const rename of diff.renameRemote) {
				await this.gdrive.updateFileMetadata(rename.id, { name: rename.to });
				const entryPath = Object.keys(remoteMetadata.files).find(p => remoteMetadata.files[p].id === rename.id);
				if (entryPath && entryPath !== rename.to) {
					remoteMetadata.files[rename.to] = remoteMetadata.files[entryPath];
					delete remoteMetadata.files[entryPath];
				}
			}

			for (const path of diff.toUpload) {
				const localFile = this.app.vault.getAbstractFileByPath(path);
				if (!(localFile instanceof TFile)) continue;
				const content = await this.app.vault.read(localFile);
				const remoteEntry = remoteMetadata.files[path];
				const remoteId = remoteEntry && !remoteEntry.isDeleted ? remoteEntry.id : undefined;
				const id = await this.gdrive.uploadFile(path, content, folderId, remoteId);
				remoteMetadata.files[path] = {
					id: id,
					hash: localCurrent[path].hash,
					modifiedTime: localCurrent[path].modifiedTime,
					size: localCurrent[path].size,
					isDeleted: false,
					mimeType: 'text/markdown'
				};
			}

			for (const path of diff.toDeleteRemote) {
				const remoteEntry = remoteMetadata.files[path];
				if (remoteEntry?.id) {
					await this.gdrive.deleteFile(remoteEntry.id);
					remoteMetadata.files[path].isDeleted = true;
				}
			}

			remoteMetadata.lastSyncTimestamp = Date.now();
			remoteMetadata.lastSyncByDevice = this.settings.userName || 'unknown';
			remoteMetadata.rootFolderId = folderId;

			try {
				metadataFileId = await this.gdrive.uploadFile(
					'metadata.json',
					JSON.stringify(remoteMetadata, null, 2),
					folderId,
					metadataFileId || undefined,
					{ ifMatch: metadataEtag || undefined, mimeType: 'application/json' }
				);
			} catch (e: any) {
				if (String(e.message || '').includes('412')) {
					new Notice("Sync interrupted: remote metadata changed. Please sync again.");
					this.debugLog("Metadata upload precondition failed", e);
					return;
				}
				throw e;
			}

			await this.saveLocalState(remoteMetadata);

			const finalScan = await this.scanLocalFiles(hashCacheState);
			hashCacheState = finalScan.cache;
			await this.saveLocalHashCache(hashCacheState);
			this.clearDelta();

			new Notice("Sync complete!");
			this.debugLog("Sync complete");
		} catch (e: any) {
			new Notice(`Sync failed: ${e.message}`);
			this.debugLog("Sync failed", e);
		} finally {
			this.syncInProgress = false;
			this.setSyncingIndicator(false);
			if (trigger === 'manual') {
				this.resetAutoSyncTimer();
			}
		}
	}

	async forcePush() {
		if (!this.settings.accessToken) {
			new Notice("Please authenticate in settings first.");
			return;
		}

		try {
			this.debugLog("Force push started");
			const folderId = await this.getRemoteFolderId();
			if (!folderId) return;
			const remoteFiles = await this.gdrive.listFiles(folderId);
			const localFiles = this.app.vault.getFiles();

			console.log(folderId, remoteFiles.length, localFiles.length);

			new Notice("Force pushing local to remote...");

			const uploadedIds: Record<string, string> = {};

			// Delete remote files that don't exist locally
			for (const remoteFile of remoteFiles) {
				if (!localFiles.find(f => f.path === remoteFile.name)) {
					if (remoteFile.capabilities?.canDelete) {
						await this.gdrive.deleteFile(remoteFile.id);
					} else {
						console.warn(`Cannot delete remote file ${remoteFile.name} (insufficient permissions)`);
					}
				}
			}

			for (const localFile of localFiles) {
				const remoteFile = remoteFiles.find(f => f.name === localFile.path);
				if (remoteFile && !remoteFile.capabilities?.canEdit) {
					console.warn(`Cannot update remote file ${localFile.path} (insufficient permissions). Skipping.`);
					continue;
				}
				const content = await this.app.vault.read(localFile);
				const id = await this.gdrive.uploadFile(localFile.path, content, folderId, remoteFile?.id);
				uploadedIds[localFile.path] = id;
			}

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache);
			const localCurrent = scan.files;
			const hashCacheState = scan.cache;
			const newMetadata: RemoteMetadataFile = {
				schemaVersion: 1,
				rootFolderId: folderId,
				lastSyncTimestamp: Date.now(),
				lastSyncByDevice: this.settings.userName || 'unknown',
				files: {}
			};

			for (const [path, entry] of Object.entries(localCurrent)) {
				newMetadata.files[path] = {
					id: uploadedIds[path],
					hash: entry.hash,
					modifiedTime: entry.modifiedTime,
					size: entry.size,
					isDeleted: false,
					mimeType: 'text/markdown'
				};
			}

			await this.gdrive.uploadFile(
				'metadata.json',
				JSON.stringify(newMetadata, null, 2),
				folderId,
				undefined,
				{ mimeType: 'application/json' }
			);

			await this.saveLocalState(newMetadata);
			await this.saveLocalHashCache(hashCacheState);
			this.clearDelta();

			new Notice("Force push complete!");
			this.debugLog("Force push complete");
		} catch (e: any) {
			new Notice(`Force push failed: ${e.message}`);
			this.debugLog("Force push failed", e);
		}
	}

	async forcePull() {
		if (!this.settings.accessToken) {
			new Notice("Please authenticate in settings first.");
			return;
		}

		try {
			this.debugLog("Force pull started");
			const folderId = await this.getRemoteFolderId();
			if (!folderId) return;

			const remoteFiles = await this.gdrive.listFiles(folderId);
			this.debugLog("Force pull remote count", remoteFiles.length);

			new Notice("Force pulling remote to local...");

			const localFiles = this.app.vault.getFiles();
			// Delete local files that don't exist remotely
			for (const localFile of localFiles) {
				if (!remoteFiles.find(f => f.name === localFile.path)) {
					await this.app.vault.delete(localFile);
				}
			}

			for (const remoteFile of remoteFiles) {
				const content = await this.gdrive.downloadFile(remoteFile.id);
				const localFile = this.app.vault.getAbstractFileByPath(remoteFile.name);

				if (localFile instanceof TFile) {
					await this.app.vault.modifyBinary(localFile, content);
				} else {
					await this.app.vault.createBinary(remoteFile.name, content);
				}
			}

			const newMetadata = await this.buildRemoteMetadataFromDrive(folderId);
			newMetadata.lastSyncTimestamp = Date.now();
			newMetadata.lastSyncByDevice = this.settings.userName || 'unknown';
			await this.gdrive.uploadFile(
				'metadata.json',
				JSON.stringify(newMetadata, null, 2),
				folderId,
				undefined,
				{ mimeType: 'application/json' }
			);

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache);
			const hashCacheState = scan.cache;

			await this.saveLocalState(newMetadata);
			await this.saveLocalHashCache(hashCacheState);
			this.clearDelta();

			new Notice("Force pull complete!");
			this.debugLog("Force pull complete");
		} catch (e: any) {
			new Notice(`Force pull failed: ${e.message}`);
			this.debugLog("Force pull failed", e);
		}
	}

	async logout() {
		this.debugLog("Logging out");
		this.settings.accessToken = '';
		this.settings.refreshToken = '';
		this.settings.userName = '';
		this.settings.remoteFolderId = '';
		await this.saveSettings();
		this.gdrive.setTokens('', '');
		new Notice("Logged out successfully.");
		(this.app as any).setting.openTabById(this.manifest.id);
	}

	async forceRefreshAccessToken() {
		try {
			this.debugLog("Force refresh access token requested");
			const newAccessToken = await this.gdrive.refreshAccessToken();
			this.settings.accessToken = newAccessToken;
			await this.saveSettings();
			this.debugLog("Force refresh access token success", newAccessToken);
			new Notice("Access token refreshed.");
		} catch (e: any) {
			this.debugLog("Force refresh access token failed", e);
			new Notice(`Access token refresh failed: ${e.message}`);
		}
	}
}

class OAuthModal extends Modal {
	result: string = "";
	onSubmit: (result: string) => void;
	authUrl: string;

	constructor(app: App, authUrl: string, onSubmit: (result: string) => void) {
		super(app);
		this.authUrl = authUrl;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Manual Authentication" });

		contentEl.createEl("p", { text: "Please follow these steps to authenticate:" });

		const list = contentEl.createEl("ol");
		list.createEl("li", { text: "Click 'Open Login Page' below." });
		list.createEl("li", { text: "Sign in and grant access." });
		list.createEl("li", { text: "After being redirected, copy the code from the address bar (the part after 'code=') and paste it below." });

		const btnContainer = contentEl.createDiv({ cls: "sync-drive-modal-buttons" });
		const loginBtn = btnContainer.createEl("button", { text: "Open Login Page", cls: "mod-cta" });
		loginBtn.onclick = () => {
			window.open(this.authUrl);
		};

		new Setting(contentEl)
			.setName("Authorization Code")
			.setDesc("Paste the code from the browser URL here.")
			.addText((text) =>
				text.setPlaceholder("4/0Af...")
					.onChange((value) => {
						this.result = value;
					})
			);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Finish Login")
					.setCta()
					.onClick(() => {
						if (this.result) {
							this.close();
							this.onSubmit(this.result);
						} else {
							new Notice("Please enter the code first.");
						}
					})
			);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}

class SyncDriveSettingTab extends PluginSettingTab {
	plugin: SyncDrivePlugin;

	constructor(app: App, plugin: SyncDrivePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Sync Drive Settings' });

		if (this.plugin.settings.userName) {
			containerEl.createEl('p', { text: `Logged in as: ${this.plugin.settings.userName}`, cls: 'sync-drive-user-info' });
		}

		new Setting(containerEl)
			.setName('Authentication')
			.setDesc(this.plugin.settings.accessToken ? 'You are authenticated with Google Drive.' : 'Login with your Google account to sync notes.')
			.addButton(button => {
				const isAuthenticated = !!this.plugin.settings.accessToken;
				button
					.setButtonText(isAuthenticated ? 'Logout' : 'Login')
					.setCta()
					.onClick(async () => {
						if (isAuthenticated) {
							await this.plugin.logout();
						} else {
							await this.plugin.authenticate();
						}
					});
			});

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable extra console logs to troubleshoot authentication and sync.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						this.plugin.settings.debugLogging = value;
						this.plugin.setDebugEnabled(value);
						await this.plugin.saveSettings();
						this.plugin.debugLog("Debug logging enabled");
					});
			});

		new Setting(containerEl)
			.setName('Auto sync')
			.setDesc('Automatically sync on an interval.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.autoSyncEnabled) {
			new Setting(containerEl)
				.setName('Auto sync interval')
				.setDesc('How often to run auto sync.')
				.addText(text => {
					text
						.setPlaceholder('5')
						.setValue(String(this.plugin.settings.autoSyncIntervalValue))
						.onChange(async (value) => {
							const parsed = Number(value);
							if (!Number.isFinite(parsed) || parsed <= 0) return;
							this.plugin.settings.autoSyncIntervalValue = parsed;
							await this.plugin.saveSettings();
						});
				})
				.addDropdown(dropdown => {
					dropdown
						.addOption('minutes', 'Minutes')
						.addOption('seconds', 'Seconds')
						.setValue(this.plugin.settings.autoSyncIntervalUnit)
						.onChange(async (value: string) => {
							if (value !== 'seconds' && value !== 'minutes') return;
							this.plugin.settings.autoSyncIntervalUnit = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName('Manual sync')
			.setDesc('Run sync actions on demand.')
			.addButton(button => {
				button
					.setButtonText('Sync now')
					.setCta()
					.onClick(async () => {
						await this.plugin.sync();
					});
			})
			.addButton(button => {
				button
					.setButtonText('Force push')
					.onClick(async () => {
						await this.plugin.forcePush();
					});
			})
			.addButton(button => {
				button
					.setButtonText('Force pull')
					.onClick(async () => {
						await this.plugin.forcePull();
					});
			});

		if (this.plugin.settings.debugLogging) {
			new Setting(containerEl)
				.setName('Force token refresh')
				.setDesc('Refresh the access token using the stored refresh token.')
				.addButton(button => {
					button
						.setButtonText('Refresh access token')
						.onClick(async () => {
							await this.plugin.forceRefreshAccessToken();
						});
				});
		}
	}
}
