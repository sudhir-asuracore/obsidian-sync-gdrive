import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, ObsidianProtocolData, Menu as ObsidianMenu, setIcon } from 'obsidian';
import { GDriveHelper } from './src/gdrive';
import { EncryptionService } from './src/encryption';
import { Md5Utils } from './src/utils/md5';

const textDecoder = new TextDecoder('utf-8');

interface SyncDriveSettings {
	accessToken: string;
	refreshToken: string;
	remoteFolderId: string;
	userName: string;
	currentVaultId: string;
	currentVaultName: string;
	excludedFolders: string;
	excludedPatterns: string;
	syncImages: boolean;
	syncAudio: boolean;
	syncVideos: boolean;
	syncPdfs: boolean;
	syncAppearanceSettings: boolean;
	syncThemesAndSnippets: boolean;
	syncPlugins: boolean;
	syncHotkeys: boolean;
	encryptionKey: string;
	autoSyncEnabled: boolean;
	autoSyncIntervalValue: number;
	autoSyncIntervalUnit: 'seconds' | 'minutes';
}

const DEFAULT_SETTINGS: SyncDriveSettings = {
	accessToken: '',
	refreshToken: '',
	remoteFolderId: '',
	userName: '',
	currentVaultId: '',
	currentVaultName: '',
	excludedFolders: '',
	excludedPatterns: '',
	syncImages: true,
	syncAudio: true,
	syncVideos: true,
	syncPdfs: true,
	syncAppearanceSettings: true,
	syncThemesAndSnippets: true,
	syncPlugins: true,
	syncHotkeys: true,
	encryptionKey: '',
	autoSyncEnabled: false,
	autoSyncIntervalValue: 5,
	autoSyncIntervalUnit: 'minutes'
}

const ROOT_FOLDER_NAME = 'obsidian_notes';
const METADATA_FILE_NAME = 'metadata.json';
const VAULT_META_FILE_NAME = 'vaults-meta.json';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'tif', 'tiff', 'heic', 'heif']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus', 'aiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', '3gp']);

const APPEARANCE_SETTING_FILES = new Set([
	'appearance.json',
	'snippets.json'
]);
const SYNC_IO_CONCURRENCY = 4;
const DRIVE_LIST_CONCURRENCY = 4;
const HASH_CONCURRENCY = 4;
const DELTA_SCAN_MAX_PATHS = 500;
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REMOTE_CACHE_SCHEMA_VERSION = 1;
const FOLDER_CACHE_SCHEMA_VERSION = 1;

interface RemoteMetadataEntry {
	id?: string;
	hash?: string;
	modifiedTime?: number;
	size?: number;
	isDeleted?: boolean;
	mimeType?: string;
	version?: number;
	parentId?: string;
}

interface RemoteMetadataFile {
	schemaVersion: number;
	rootFolderId: string;
	lastSyncTimestamp: number;
	lastSyncByDevice?: string;
	files: Record<string, RemoteMetadataEntry>;
	encrypt_tester?: string;
}

type LocalStateFile = RemoteMetadataFile;

interface VaultMetaEntry {
	id: string;
	name: string;
	createdAt: number;
	lastSyncTimestamp?: number;
	lastSyncByDevice?: string;
}

interface VaultsMetaFile {
	schemaVersion: number;
	updatedAt: number;
	vaults: VaultMetaEntry[];
}

interface LocalVaultsMetaFile extends VaultsMetaFile {
	rootFolderId: string;
	remoteFileId?: string;
	remoteVersion?: string;
	cachedAt: number;
}

interface LocalHashCacheEntry {
	hash: string;
	modifiedTime: number;
	size: number;
}

interface LocalHashCacheFile {
	schemaVersion: number;
	updatedAt: number;
	files: Record<string, LocalHashCacheEntry>;
	fullScanAt?: number;
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

type SyncActionType = 'sync' | 'forcePush' | 'forcePull';

interface SyncProgressState {
	current: number;
	total: number;
	action: SyncActionType | null;
	label?: string;
}

interface RemoteFolderCacheEntry {
	id: string;
	name: string;
	parentId?: string;
	path: string;
}

interface RemoteFileCacheEntry {
	id: string;
	name: string;
	path: string;
	parentId?: string;
	mimeType?: string;
	modifiedTime?: string;
	md5Checksum?: string;
	size?: string;
	version?: string;
	trashed?: boolean;
	capabilities?: any;
}

interface RemoteFileCacheFile {
	schemaVersion: number;
	rootFolderId: string;
	changeToken?: string;
	cachedAt: number;
	files: Record<string, RemoteFileCacheEntry>;
	folders: Record<string, RemoteFolderCacheEntry>;
}

interface FolderPathCacheFile {
	schemaVersion: number;
	rootFolderId: string;
	cachedAt: number;
	entries: Record<string, string>;
}

export default class SyncDrivePlugin extends Plugin {
	settings!: SyncDriveSettings;
	gdrive!: GDriveHelper;
	private debugEnabled = false;
	private syncInProgress = false;
	private syncActionType: SyncActionType | null = null;
	private syncActionListener: ((inProgress: boolean, action: SyncActionType | null) => void) | null = null;
	private syncProgressListener: ((state: SyncProgressState) => void) | null = null;
	private syncProgressState: SyncProgressState = { current: 0, total: 0, action: null };
	private ribbonIconEl: HTMLElement | null = null;
	private autoSyncTimer: number | null = null;
	private deltaDirtyPaths = new Set<string>();
	private deltaFlushTimer: number | null = null;
	private deltaLoaded = false;
	private deltaVaultKey: string | null = null;
	private folderPathCacheRootId: string | null = null;
	private encryptionService: EncryptionService;

	constructor(app: App, manifest: any) {
		super(app, manifest);
		this.encryptionService = new EncryptionService({
			getKey: () => this.getEncryptionKey(),
			getMismatchMessage: () => this.getEncryptionMismatchMessage(),
			isEnabled: () => this.isEncryptionEnabled()
		});
	}
	private vaultsMetaCache: VaultsMetaFile | null = null;
	private vaultsMetaFileId: string | null = null;
	private vaultsMetaRootId: string | null = null;
	private vaultsMetaVersion: string | null = null;

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

	isDebugEnabled(): boolean {
		return this.debugEnabled;
	}

	setSyncActionStateListener(listener: ((inProgress: boolean, action: SyncActionType | null) => void) | null) {
		this.syncActionListener = listener;
	}

	setSyncProgressListener(listener: ((state: SyncProgressState) => void) | null) {
		this.syncProgressListener = listener;
		if (listener) {
			listener(this.syncProgressState);
		}
	}

	getSyncProgressState(): SyncProgressState {
		return this.syncProgressState;
	}

	isSyncActionInProgress(): boolean {
		return this.syncInProgress;
	}

	getSyncActionType(): SyncActionType | null {
		return this.syncActionType;
	}

	private setSyncActionState(inProgress: boolean, action: SyncActionType | null) {
		this.syncInProgress = inProgress;
		this.syncActionType = action;
		if (this.syncActionListener) {
			this.syncActionListener(inProgress, action);
		}
	}

	private updateSyncProgress(current: number, total: number, label?: string) {
		this.syncProgressState = { current, total, action: this.syncActionType, label };
		if (this.syncProgressListener) {
			this.syncProgressListener(this.syncProgressState);
		}
	}

	private resetSyncProgress() {
		this.syncProgressState = { current: 0, total: 0, action: null };
		if (this.syncProgressListener) {
			this.syncProgressListener(this.syncProgressState);
		}
	}

	private tryBeginSyncAction(action: SyncActionType, trigger: 'manual' | 'auto' = 'manual'): boolean {
		if (this.syncInProgress) {
			if (trigger === 'manual') {
				new Notice("Another sync operation is already in progress.");
			}
			return false;
		}
		this.setSyncActionState(true, action);
		this.updateSyncProgress(0, 0);
		return true;
	}

	private endSyncAction() {
		this.setSyncActionState(false, null);
		this.resetSyncProgress();
	}

	private getDebugLoggingFromEnv(): boolean {
		const raw = String(process.env.SYNC_DRIVE_DEBUG_LOGGING || '').trim().toLowerCase();
		if (!raw) return false;
		return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
	}

	private getEncryptionKey(): string {
		return this.settings.encryptionKey || '';
	}

	private isEncryptionEnabled(): boolean {
		return this.getEncryptionKey().length > 0;
	}

	private getEncryptionMismatchMessage(): string {
		return 'Encryption key mismatch. Please verify the key and run a force push if the key was changed.';
	}

	private async decryptContentOrThrow(data: ArrayBuffer): Promise<ArrayBuffer> {
		return await this.encryptionService.decryptContentOrThrow(data);
	}

	private async applyEncryptionTester(metadata: RemoteMetadataFile): Promise<RemoteMetadataFile> {
		metadata.encrypt_tester = await this.encryptionService.buildEncryptionTester();
		return metadata;
	}

	private async verifyEncryptionTester(metadata: RemoteMetadataFile): Promise<void> {
		await this.encryptionService.verifyEncryptionTester(metadata.encrypt_tester);
	}

	private async readLocalFileForUpload(path: string, localFile: TFile | null): Promise<ArrayBuffer> {
		if (this.isEncryptionEnabled()) {
			const content = localFile instanceof TFile
				? await this.app.vault.readBinary(localFile)
				: await this.app.vault.adapter.readBinary(path);
			return await this.encryptionService.encryptContent(content);
		}

		return localFile instanceof TFile
			? await this.app.vault.readBinary(localFile)
			: await this.app.vault.adapter.readBinary(path);
	}

	private getLocalVaultName(): string {
		const vault = this.app.vault as any;
		if (typeof vault.getName === 'function') {
			const name = vault.getName();
			if (name) return String(name);
		} else if (vault.getName) {
			return String(vault.getName);
		}

		const root = this.app.vault.getRoot?.();
		if (root?.name) return root.name;
		return 'vault';
	}

	private computeStringHash(value: string): string {
		return Md5Utils.md5String(value);
	}

	private getRootScopedFileName(baseName: string, rootFolderId: string): string {
		const key = this.computeStringHash(rootFolderId);
		const dot = baseName.lastIndexOf('.');
		if (dot === -1) {
			return `${baseName}-${key}`;
		}
		return `${baseName.slice(0, dot)}-${key}${baseName.slice(dot)}`;
	}

	private getVaultStateKey(): string {
		const source = this.settings.currentVaultId
			|| this.settings.currentVaultName
			|| this.getLocalVaultName();
		return this.computeStringHash(String(source));
	}

	private getVaultScopedFileName(baseName: string): string {
		const key = this.getVaultStateKey();
		const dot = baseName.lastIndexOf('.');
		if (dot === -1) {
			return `${baseName}-${key}`;
		}
		return `${baseName.slice(0, dot)}-${key}${baseName.slice(dot)}`;
	}

	private isReservedRemotePath(path: string): boolean {
		const normalized = this.normalizePath(path);
		return normalized === METADATA_FILE_NAME || normalized === VAULT_META_FILE_NAME;
	}

	private getRemoteFilePath(remoteFile: any): string {
		return this.normalizePath(remoteFile.path || remoteFile.name || '');
	}

	private filterRemoteVaultFiles(remoteFiles: any[]): any[] {
		return remoteFiles.filter(file => !this.isReservedRemotePath(this.getRemoteFilePath(file)));
	}

	private normalizePath(path: string): string {
		return path.replace(/\\/g, '/');
	}

	private getPathDir(path: string): string {
		const normalized = this.normalizePath(path);
		const slash = normalized.lastIndexOf('/');
		if (slash === -1) return '';
		return normalized.slice(0, slash);
	}

	private getPathBase(path: string): string {
		const normalized = this.normalizePath(path);
		const slash = normalized.lastIndexOf('/');
		if (slash === -1) return normalized;
		return normalized.slice(slash + 1);
	}

	private getConfigDirPrefix(): string {
		const configDir = this.app.vault.configDir || '.obsidian';
		const normalized = this.normalizePath(configDir).replace(/^\/+/, '').replace(/\/+$/, '');
		return `${normalized}/`;
	}

	private shouldIncludeConfigFiles(): boolean {
		return !!(
			this.settings.syncAppearanceSettings
			|| this.settings.syncThemesAndSnippets
			|| this.settings.syncPlugins
			|| this.settings.syncHotkeys
		);
	}

	private async listConfigDirFiles(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		const configDir = (this.app.vault.configDir || '.obsidian').replace(/\\/g, '/');
		try {
			const exists = await adapter.exists(configDir);
			if (!exists) return [];
		} catch {
			return [];
		}

		const files: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			const listing = await adapter.list(dir);
			for (const file of listing.files) {
				files.push(file.replace(/\\/g, '/'));
			}
			for (const folder of listing.folders) {
				await walk(folder.replace(/\\/g, '/'));
			}
		};

		await walk(configDir);
		return files;
	}

	private async buildLocalFileMap(): Promise<Map<string, TFile | null>> {
		const map = new Map<string, TFile | null>();
		for (const localFile of this.app.vault.getFiles()) {
			map.set(localFile.path, localFile);
		}

		if (this.shouldIncludeConfigFiles()) {
			const configFiles = await this.listConfigDirFiles();
			for (const path of configFiles) {
				if (!map.has(path)) {
					map.set(path, null);
				}
			}
		}

		return map;
	}

	private async ensureLocalFolderForPath(path: string): Promise<void> {
		const dir = this.getPathDir(path);
		if (!dir) return;
		const adapter = this.app.vault.adapter;
		const segments = dir.split('/').filter(Boolean);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			try {
				const exists = await adapter.exists(current);
				if (!exists) {
					await adapter.mkdir(current);
				}
			} catch {
				// Ignore errors for existing folders or adapters without mkdir support.
			}
		}
	}

	private isObsidianPathAllowed(path: string): boolean {
		const normalized = this.normalizePath(path);
		const configPrefix = this.getConfigDirPrefix();
		if (!normalized.startsWith(configPrefix)) return false;

		const relative = normalized.slice(configPrefix.length);
		if (this.settings.syncAppearanceSettings && APPEARANCE_SETTING_FILES.has(relative)) {
			return true;
		}
		if (this.settings.syncHotkeys && relative === 'hotkeys.json') {
			return true;
		}
		if (this.settings.syncThemesAndSnippets) {
			if (relative.startsWith('themes/') || relative.startsWith('snippets/')) {
				return true;
			}
		}
		if (this.settings.syncPlugins && relative.endsWith('-plugins.json')) {
			return true;
		}
		if (this.settings.syncPlugins && relative.startsWith('plugins/')) {
			const selfPluginPath = `plugins/${this.manifest.id}`;
			if (relative === selfPluginPath || relative.startsWith(`${selfPluginPath}/`)) {
				return false;
			}
			return true;
		}
		return false;
	}

	private getExcludedFolderPrefixes(): string[] {
		const raw = this.settings.excludedFolders || '';
		return raw
			.split(/[\n,;]+/)
			.map(entry => entry.trim())
			.filter(Boolean)
			.map(entry => this.normalizePath(entry.replace(/^\/+/, '')))
			.map(entry => (entry.endsWith('/') ? entry : `${entry}/`));
	}

	private globToRegExp(pattern: string): RegExp {
		let expression = '^';
		const normalized = this.normalizePath(pattern);
		for (const char of normalized) {
			if (char === '*') {
				expression += '.*';
			} else if (char === '?') {
				expression += '.';
			} else {
				expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			}
		}
		expression += '$';
		return new RegExp(expression);
	}

	private matchesExcludePatterns(path: string): boolean {
		const raw = this.settings.excludedPatterns || '';
		const patterns = raw
			.split(/[\n,;]+/)
			.map(entry => entry.trim())
			.filter(Boolean);
		if (!patterns.length) return false;

		const normalized = this.normalizePath(path);
		for (const pattern of patterns) {
			if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
				try {
					const regex = new RegExp(pattern.slice(1, -1));
					if (regex.test(normalized)) return true;
				} catch (e) {
					continue;
				}
			} else {
				const regex = this.globToRegExp(pattern);
				if (regex.test(normalized)) return true;
			}
		}
		return false;
	}

	private getPathExtension(path: string): string {
		const normalized = this.normalizePath(path);
		const slash = normalized.lastIndexOf('/');
		const dot = normalized.lastIndexOf('.');
		if (dot === -1 || (slash !== -1 && dot < slash)) return '';
		return normalized.slice(dot + 1).toLowerCase();
	}

	private isExcludedByFileType(path: string): boolean {
		const ext = this.getPathExtension(path);
		if (!ext) return false;
		if (!this.settings.syncImages && IMAGE_EXTENSIONS.has(ext)) return true;
		if (!this.settings.syncAudio && AUDIO_EXTENSIONS.has(ext)) return true;
		if (!this.settings.syncVideos && VIDEO_EXTENSIONS.has(ext)) return true;
		if (!this.settings.syncPdfs && ext === 'pdf') return true;
		return false;
	}

	private isPathExcluded(path: string): boolean {
		if (!path) return false;
		const normalized = this.normalizePath(path);
		const configPrefix = this.getConfigDirPrefix();
		if (normalized.startsWith(configPrefix)) {
			if (!this.isObsidianPathAllowed(normalized)) return true;
		}

		const prefixes = this.getExcludedFolderPrefixes();
		for (const prefix of prefixes) {
			if (normalized.startsWith(prefix)) return true;
		}

		if (this.matchesExcludePatterns(normalized)) return true;
		if (this.isExcludedByFileType(normalized)) return true;

		return false;
	}

	private filterRemoteVaultFilesForSync(remoteFiles: any[]): any[] {
		return remoteFiles.filter(file => {
			const path = this.getRemoteFilePath(file);
			return !this.isReservedRemotePath(path) && !this.isPathExcluded(path);
		});
	}

	private filterLocalCurrentBySyncRules(localCurrent: Record<string, LocalFileState>): Record<string, LocalFileState> {
		const filtered: Record<string, LocalFileState> = {};
		for (const [path, entry] of Object.entries(localCurrent)) {
			if (!this.isPathExcluded(path)) {
				filtered[path] = entry;
			}
		}
		return filtered;
	}

	private filterMetadataBySyncRules(metadata: RemoteMetadataFile): RemoteMetadataFile {
		const filtered: Record<string, RemoteMetadataEntry> = {};
		for (const [path, entry] of Object.entries(metadata.files)) {
			if (!this.isPathExcluded(path)) {
				filtered[path] = entry;
			}
		}
		return {
			...metadata,
			files: filtered
		};
	}

	private resetVaultScopedState() {
		this.deltaDirtyPaths = new Set<string>();
		this.deltaLoaded = false;
		this.deltaVaultKey = null;
		this.clearDeltaFlushTimer();
		this.folderPathCacheRootId = null;
		if (this.gdrive) {
			this.gdrive.setFolderPathCache({});
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
		const scopedPath = this.getPluginDataPath(this.getVaultScopedFileName('local-state.json'));
		const legacyPath = this.getPluginDataPath('local-state.json');
		try {
			if (await this.app.vault.adapter.exists(scopedPath)) {
				const raw = await this.app.vault.adapter.read(scopedPath);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1 && parsed.files) {
					return parsed as LocalStateFile;
				}
			} else if (await this.app.vault.adapter.exists(legacyPath)) {
				const raw = await this.app.vault.adapter.read(legacyPath);
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
		const path = this.getPluginDataPath(this.getVaultScopedFileName('local-state.json'));
		await this.app.vault.adapter.write(path, JSON.stringify(state, null, 2));
	}

	private async loadLocalHashCache(): Promise<LocalHashCacheFile> {
		const scopedPath = this.getPluginDataPath(this.getVaultScopedFileName('local-hash-cache.json'));
		const legacyPath = this.getPluginDataPath('local-hash-cache.json');
		try {
			if (await this.app.vault.adapter.exists(scopedPath)) {
				const raw = await this.app.vault.adapter.read(scopedPath);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1 && parsed.files) {
					return parsed as LocalHashCacheFile;
				}
			} else if (await this.app.vault.adapter.exists(legacyPath)) {
				const raw = await this.app.vault.adapter.read(legacyPath);
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
			fullScanAt: 0,
			files: {}
		};
	}

	private async saveLocalHashCache(cache: LocalHashCacheFile): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath(this.getVaultScopedFileName('local-hash-cache.json'));
		await this.app.vault.adapter.write(path, JSON.stringify(cache, null, 2));
	}

	private getFolderPathCacheFileName(rootFolderId: string): string {
		return this.getRootScopedFileName('folder-path-cache.json', rootFolderId);
	}

	private async loadFolderPathCache(rootFolderId: string): Promise<void> {
		if (this.folderPathCacheRootId === rootFolderId) return;
		this.folderPathCacheRootId = rootFolderId;
		const path = this.getPluginDataPath(this.getFolderPathCacheFileName(rootFolderId));
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === FOLDER_CACHE_SCHEMA_VERSION && parsed.entries) {
					this.gdrive.setFolderPathCache(parsed.entries);
					return;
				}
			}
		} catch (e) {
			console.warn("Failed to load folder path cache", e);
		}
		this.gdrive.setFolderPathCache({});
	}

	private async saveFolderPathCache(rootFolderId: string): Promise<void> {
		await this.ensurePluginDataDir();
		const entries = this.gdrive.getFolderPathCache();
		const payload: FolderPathCacheFile = {
			schemaVersion: FOLDER_CACHE_SCHEMA_VERSION,
			rootFolderId,
			cachedAt: Date.now(),
			entries
		};
		const path = this.getPluginDataPath(this.getFolderPathCacheFileName(rootFolderId));
		await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
	}

	private async ensureRemoteFolders(rootFolderId: string, folderPaths: string[]): Promise<void> {
		const unique = Array.from(new Set(folderPaths.filter(Boolean)));
		if (unique.length === 0) return;
		await this.loadFolderPathCache(rootFolderId);
		await this.runWithConcurrency(unique, DRIVE_LIST_CONCURRENCY, async (folderPath) => {
			await this.gdrive.ensureFolderPath(rootFolderId, folderPath);
		});
		await this.saveFolderPathCache(rootFolderId);
	}

	private getRemoteFileCacheFileName(rootFolderId: string): string {
		return this.getRootScopedFileName('remote-files-cache.json', rootFolderId);
	}

	private async loadRemoteFileCache(rootFolderId: string): Promise<RemoteFileCacheFile | null> {
		const path = this.getPluginDataPath(this.getRemoteFileCacheFileName(rootFolderId));
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === REMOTE_CACHE_SCHEMA_VERSION && parsed.rootFolderId === rootFolderId) {
					return parsed as RemoteFileCacheFile;
				}
			}
		} catch (e) {
			console.warn("Failed to load remote file cache", e);
		}
		return null;
	}

	private async saveRemoteFileCache(cache: RemoteFileCacheFile): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath(this.getRemoteFileCacheFileName(cache.rootFolderId));
		await this.app.vault.adapter.write(path, JSON.stringify(cache, null, 2));
	}

	private async buildRemoteFileCacheFromListing(rootFolderId: string): Promise<RemoteFileCacheFile> {
		const listing = await this.gdrive.listFilesRecursiveWithFolders(rootFolderId, DRIVE_LIST_CONCURRENCY);
		const files: Record<string, RemoteFileCacheEntry> = {};
		for (const file of listing.files) {
			const path = this.getRemoteFilePath(file);
			if (!path) continue;
			files[file.id] = {
				id: file.id,
				name: file.name,
				path,
				parentId: file.parentId,
				mimeType: file.mimeType,
				modifiedTime: file.modifiedTime,
				md5Checksum: file.md5Checksum,
				size: file.size,
				version: file.version,
				trashed: file.trashed,
				capabilities: file.capabilities
			};
		}
		const folders: Record<string, RemoteFolderCacheEntry> = {};
		for (const folder of listing.folders) {
			folders[folder.id] = {
				id: folder.id,
				name: folder.name,
				parentId: folder.parentId,
				path: folder.path
			};
		}
		const changeToken = await this.gdrive.getChangesStartPageToken();
		return {
			schemaVersion: REMOTE_CACHE_SCHEMA_VERSION,
			rootFolderId,
			changeToken,
			cachedAt: Date.now(),
			files,
			folders
		};
	}

	private async updateRemoteFileCacheFromChanges(rootFolderId: string, cache: RemoteFileCacheFile): Promise<RemoteFileCacheFile> {
		if (!cache.changeToken) {
			return await this.buildRemoteFileCacheFromListing(rootFolderId);
		}

		let pageToken: string | undefined = cache.changeToken;
		let newStartToken: string | undefined;
		const changes: any[] = [];
		while (pageToken) {
			const page = await this.gdrive.listChanges(pageToken);
			if (page.changes && page.changes.length > 0) {
				changes.push(...page.changes);
			}
			if (page.newStartPageToken) {
				newStartToken = page.newStartPageToken;
			}
			pageToken = page.nextPageToken;
		}

		let needsFullRefresh = false;
		for (const change of changes) {
			const fileId = change.fileId as string;
			const removed = !!change.removed;
			if (removed) {
				if (cache.folders[fileId]) {
					needsFullRefresh = true;
					break;
				}
				delete cache.files[fileId];
				continue;
			}
			const file = change.file;
			if (!file) continue;
			const mimeType = file.mimeType as string | undefined;
			const isFolder = mimeType === 'application/vnd.google-apps.folder';
			const parentId = Array.isArray(file.parents) && file.parents.length > 0 ? file.parents[0] : undefined;
			const parentEntry = parentId && parentId !== rootFolderId ? cache.folders[parentId] : undefined;
			const parentPath = parentEntry ? parentEntry.path : '';
			if (isFolder) {
				if (file.trashed) {
					if (cache.folders[fileId]) {
						needsFullRefresh = true;
						break;
					}
					continue;
				}
				if (parentId && parentId !== rootFolderId && !parentEntry) {
					if (cache.folders[fileId]) {
						needsFullRefresh = true;
						break;
					}
					continue;
				}
				const folderPath = parentPath ? `${parentPath}/${file.name}` : file.name;
				const existing = cache.folders[fileId];
				if (existing && existing.path !== folderPath) {
					needsFullRefresh = true;
					break;
				}
				cache.folders[fileId] = {
					id: fileId,
					name: file.name,
					parentId: parentId,
					path: folderPath
				};
				continue;
			}
			if (file.trashed) {
				delete cache.files[fileId];
				continue;
			}
			if (parentId && parentId !== rootFolderId && !parentEntry) {
				if (cache.files[fileId]) {
					needsFullRefresh = true;
					break;
				}
				continue;
			}
			const path = parentPath ? `${parentPath}/${file.name}` : file.name;
			cache.files[fileId] = {
				id: fileId,
				name: file.name,
				path,
				parentId: parentId,
				mimeType: mimeType,
				modifiedTime: file.modifiedTime,
				md5Checksum: file.md5Checksum,
				size: file.size,
				version: file.version,
				trashed: file.trashed,
				capabilities: file.capabilities
			};
		}

		if (needsFullRefresh) {
			return await this.buildRemoteFileCacheFromListing(rootFolderId);
		}

		cache.changeToken = newStartToken || cache.changeToken;
		cache.cachedAt = Date.now();
		return cache;
	}

	private async getRemoteFilesForForceOps(rootFolderId: string): Promise<any[]> {
		let cache = await this.loadRemoteFileCache(rootFolderId);
		if (!cache) {
			cache = await this.buildRemoteFileCacheFromListing(rootFolderId);
			await this.saveRemoteFileCache(cache);
			return Object.values(cache.files);
		}

		const updated = await this.updateRemoteFileCacheFromChanges(rootFolderId, cache);
		await this.saveRemoteFileCache(updated);
		return Object.values(updated.files);
	}

	private async loadDeltaState(): Promise<void> {
		const key = this.getVaultStateKey();
		if (this.deltaLoaded && this.deltaVaultKey === key) return;
		this.deltaDirtyPaths = new Set<string>();
		const scopedPath = this.getPluginDataPath(this.getVaultScopedFileName('autosync-delta.json'));
		const legacyPath = this.getPluginDataPath('autosync-delta.json');
		try {
			if (await this.app.vault.adapter.exists(scopedPath)) {
				const raw = await this.app.vault.adapter.read(scopedPath);
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.paths)) {
					this.deltaDirtyPaths = new Set(parsed.paths);
				}
			} else if (await this.app.vault.adapter.exists(legacyPath)) {
				const raw = await this.app.vault.adapter.read(legacyPath);
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.paths)) {
					this.deltaDirtyPaths = new Set(parsed.paths);
				}
			}
		} catch (e) {
			console.warn("Failed to load autosync delta state", e);
		}
		this.deltaLoaded = true;
		this.deltaVaultKey = key;
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
		const path = this.getPluginDataPath(this.getVaultScopedFileName('autosync-delta.json'));
		const payload = {
			updatedAt: Date.now(),
			paths: Array.from(this.deltaDirtyPaths)
		};
		await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
	}

	private markDelta(path?: string) {
		if (path && !this.isPathExcluded(path)) {
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

	private createEmptyVaultsMeta(): VaultsMetaFile {
		return {
			schemaVersion: 1,
			updatedAt: Date.now(),
			vaults: []
		};
	}

	private async loadLocalVaultsMeta(rootFolderId: string): Promise<LocalVaultsMetaFile | null> {
		const path = this.getPluginDataPath(this.getRootScopedFileName('vaults-meta-local.json', rootFolderId));
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(raw);
				if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.vaults) && parsed.rootFolderId === rootFolderId) {
					return parsed as LocalVaultsMetaFile;
				}
			}
		} catch (e) {
			console.warn("Failed to load local vaults meta cache", e);
		}
		return null;
	}

	private async saveLocalVaultsMeta(rootFolderId: string, meta: VaultsMetaFile, fileId?: string | null, version?: string | null): Promise<void> {
		await this.ensurePluginDataDir();
		const path = this.getPluginDataPath(this.getRootScopedFileName('vaults-meta-local.json', rootFolderId));
		const payload: LocalVaultsMetaFile = {
			schemaVersion: meta.schemaVersion,
			updatedAt: meta.updatedAt,
			vaults: meta.vaults,
			rootFolderId: rootFolderId,
			remoteFileId: fileId || undefined,
			remoteVersion: version || undefined,
			cachedAt: Date.now()
		};
		await this.app.vault.adapter.write(path, JSON.stringify(payload, null, 2));
	}

	private async loadVaultsMeta(rootFolderId: string): Promise<{ meta: VaultsMetaFile | null; fileId: string | null; version: string | null }> {
		const metaFile = await this.gdrive.findFileByName(rootFolderId, VAULT_META_FILE_NAME);
		if (!metaFile) {
			return { meta: null, fileId: null, version: null };
		}

		const version = metaFile.version ? String(metaFile.version) : null;
		const data = await this.gdrive.downloadFile(metaFile.id);
		const raw = textDecoder.decode(data);
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.vaults)) {
				return { meta: parsed as VaultsMetaFile, fileId: metaFile.id, version: version };
			}
		} catch (e) {
			console.warn("Failed to parse vaults meta; treating as missing", e);
		}

		return { meta: null, fileId: metaFile.id || null, version: version };
	}

	private async ensureVaultsMeta(rootFolderId: string, forceRefresh = false): Promise<VaultsMetaFile> {
		if (!forceRefresh && this.vaultsMetaCache && this.vaultsMetaRootId === rootFolderId) {
			return this.vaultsMetaCache;
		}

		const metaInfo = await this.loadVaultsMeta(rootFolderId);
		if (metaInfo.meta) {
			this.vaultsMetaCache = metaInfo.meta;
			this.vaultsMetaFileId = metaInfo.fileId;
			this.vaultsMetaRootId = rootFolderId;
			this.vaultsMetaVersion = metaInfo.version;
			await this.saveLocalVaultsMeta(rootFolderId, metaInfo.meta, metaInfo.fileId, metaInfo.version);
			return metaInfo.meta;
		}

		const meta = this.createEmptyVaultsMeta();
		// If legacy storage exists (metadata.json at root), treat root folder as a vault.
		const legacyMetadata = await this.gdrive.findFileByName(rootFolderId, METADATA_FILE_NAME);
		if (legacyMetadata) {
			meta.vaults.push({
				id: rootFolderId,
				name: this.settings.currentVaultName || this.getLocalVaultName(),
				createdAt: Date.now()
			});
		}

		const fileId = await this.gdrive.uploadFile(
			VAULT_META_FILE_NAME,
			JSON.stringify(meta, null, 2),
			rootFolderId,
			undefined,
			{ mimeType: 'application/json' }
		);
		this.vaultsMetaCache = meta;
		this.vaultsMetaFileId = fileId;
		this.vaultsMetaRootId = rootFolderId;
		this.vaultsMetaVersion = null;
		await this.saveLocalVaultsMeta(rootFolderId, meta, fileId, null);
		return meta;
	}

	private async saveVaultsMeta(rootFolderId: string, meta: VaultsMetaFile): Promise<void> {
		if (this.vaultsMetaFileId && this.vaultsMetaVersion) {
			const currentVersion = await this.gdrive.getFileVersion(this.vaultsMetaFileId);
			if (currentVersion && currentVersion !== this.vaultsMetaVersion) {
				this.debugLog("Vaults meta version changed; skipping update", {
					expected: this.vaultsMetaVersion,
					actual: currentVersion
				});
				this.vaultsMetaCache = null;
				this.vaultsMetaVersion = null;
				return;
			}
		}

		meta.updatedAt = Date.now();
		const fileId = await this.gdrive.uploadFile(
			VAULT_META_FILE_NAME,
			JSON.stringify(meta, null, 2),
			rootFolderId,
			this.vaultsMetaFileId || undefined,
			{ mimeType: 'application/json' }
		);
		const newVersion = await this.gdrive.getFileVersion(fileId);
		this.vaultsMetaCache = meta;
		this.vaultsMetaFileId = fileId;
		this.vaultsMetaRootId = rootFolderId;
		this.vaultsMetaVersion = newVersion;
		await this.saveLocalVaultsMeta(rootFolderId, meta, fileId, newVersion);
	}

	private async setCurrentVault(entry: VaultMetaEntry): Promise<void> {
		this.settings.currentVaultId = entry.id;
		this.settings.currentVaultName = entry.name;
		await this.saveSettings();
		this.resetVaultScopedState();
		await this.loadDeltaState();
	}

	private getCachedVaultList(): VaultMetaEntry[] {
		return this.vaultsMetaCache?.vaults ?? [];
	}

	private async selectOrCreateVaultByName(name?: string): Promise<VaultMetaEntry | null> {
		if (!this.settings.accessToken) return null;

		const rootFolderId = await this.getRootFolderId();
		if (!rootFolderId) return null;

		const desiredName = (name || this.settings.currentVaultName || this.getLocalVaultName()).trim();
		const meta = await this.ensureVaultsMeta(rootFolderId);

		const existing = meta.vaults.find(vault => vault.name === desiredName);
		if (existing) {
			await this.setCurrentVault(existing);
			return existing;
		}

		const existingFolderId = await this.gdrive.getFolderIdInParent(rootFolderId, desiredName);
		if (existingFolderId) {
			const entry: VaultMetaEntry = {
				id: existingFolderId,
				name: desiredName,
				createdAt: Date.now()
			};
			meta.vaults.push(entry);
			await this.saveVaultsMeta(rootFolderId, meta);
			await this.setCurrentVault(entry);
			return entry;
		}

		const folderId = await this.gdrive.createFolder(desiredName, rootFolderId);
		const entry: VaultMetaEntry = {
			id: folderId,
			name: desiredName,
			createdAt: Date.now()
		};
		meta.vaults.push(entry);
		await this.saveVaultsMeta(rootFolderId, meta);
		await this.setCurrentVault(entry);
		return entry;
	}

	private async ensureVaultSelected(rootFolderIdOverride?: string): Promise<VaultMetaEntry | null> {
		if (!this.settings.accessToken) return null;

		const rootFolderId = rootFolderIdOverride || await this.getRootFolderId();
		if (!rootFolderId) return null;

		const meta = await this.ensureVaultsMeta(rootFolderId);
		if (this.settings.currentVaultId) {
			const current = meta.vaults.find(vault => vault.id === this.settings.currentVaultId);
			if (current) return current;
		}

		const desiredName = (this.settings.currentVaultName || this.getLocalVaultName()).trim();
		const byName = meta.vaults.find(vault => vault.name === desiredName);
		if (byName) {
			await this.setCurrentVault(byName);
			return byName;
		}

		if (meta.vaults.length === 1) {
			await this.setCurrentVault(meta.vaults[0]);
			return meta.vaults[0];
		}

		return await this.selectOrCreateVaultByName(desiredName);
	}

	private async getVaultFolderId(rootFolderIdOverride?: string): Promise<string> {
		const entry = await this.ensureVaultSelected(rootFolderIdOverride);
		return entry?.id || "";
	}

	private async updateVaultMetaOnSync(rootFolderId: string, vaultId: string): Promise<void> {
		const meta = await this.ensureVaultsMeta(rootFolderId);
		const entry = meta.vaults.find(vault => vault.id === vaultId);
		if (!entry) return;
		entry.lastSyncTimestamp = Date.now();
		entry.lastSyncByDevice = this.settings.userName || 'unknown';
		await this.saveVaultsMeta(rootFolderId, meta);
	}

	private async loadRemoteMetadata(
		folderId: string,
		options?: { skipEncryptionTester?: boolean }
	): Promise<{ metadata: RemoteMetadataFile | null; fileId: string | null; version: string | null; etag: string | null }> {
		const metadataFiles = await this.gdrive.findFilesByName(folderId, METADATA_FILE_NAME);
		if (metadataFiles.length === 0) {
			return { metadata: null, fileId: null, version: null, etag: null };
		}

		let metadataFile = metadataFiles[0];
		if (metadataFiles.length > 1) {
			const sorted = [...metadataFiles].sort((a, b) => {
				const aTime = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
				const bTime = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
				if (aTime !== bTime) return bTime - aTime;
				const aVersion = a.version ? Number(a.version) : 0;
				const bVersion = b.version ? Number(b.version) : 0;
				return bVersion - aVersion;
			});
			metadataFile = sorted[0];
			this.debugLog("Multiple metadata.json files found; using most recent", {
				count: metadataFiles.length,
				chosenId: metadataFile.id
			});
		}

		const version = metadataFile.version ? String(metadataFile.version) : null;
		const etag = metadataFile.etag ? String(metadataFile.etag) : null;
		const data = await this.gdrive.downloadFile(metadataFile.id);
		const raw = textDecoder.decode(data);
		try {
			const parsed = JSON.parse(raw);
			if (parsed && parsed.schemaVersion === 1 && parsed.files) {
				if (!options?.skipEncryptionTester) {
					await this.verifyEncryptionTester(parsed as RemoteMetadataFile);
				}
				return { metadata: parsed as RemoteMetadataFile, fileId: metadataFile.id, version: version, etag: etag };
			}
		} catch (e: any) {
			if (e instanceof Error && e.message === this.getEncryptionMismatchMessage()) {
				throw e;
			}
			console.warn("Failed to parse remote metadata; treating as missing", e);
		}

		return { metadata: null, fileId: metadataFile.id || null, version: version, etag: etag };
	}

	private async buildRemoteMetadataFromDrive(folderId: string, remoteFiles?: any[]): Promise<RemoteMetadataFile> {
		const listing = remoteFiles || await this.getRemoteFilesForForceOps(folderId);
		const files: Record<string, RemoteMetadataEntry> = {};
		for (const file of listing) {
			const path = this.getRemoteFilePath(file);
			if (!path || this.isReservedRemotePath(path)) continue;
			const modifiedTime = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
			files[path] = {
				id: file.id,
				hash: file.md5Checksum,
				modifiedTime: modifiedTime,
				size: file.size ? Number(file.size) : undefined,
				isDeleted: false,
				mimeType: file.mimeType,
				version: file.version ? Number(file.version) : undefined,
				parentId: file.parentId
			};
		}

		const metadata: RemoteMetadataFile = {
			schemaVersion: 1,
			rootFolderId: folderId,
			lastSyncTimestamp: 0,
			lastSyncByDevice: this.settings.userName || 'unknown',
			files: files
		};
		return await this.applyEncryptionTester(metadata);
	}

	private computeHash(content: ArrayBuffer): string {
		return Md5Utils.md5ArrayBuffer(content);
	}

	private async runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
		if (items.length === 0) return;
		const limit = Math.max(1, Math.min(concurrency, items.length));
		let index = 0;
		let error: any = null;
		const next = () => {
			if (index >= items.length) return null;
			const current = items[index];
			index += 1;
			return current;
		};
		const workerLoop = async () => {
			while (!error) {
				const item = next();
				if (item === null) return;
				try {
					await worker(item, index - 1);
				} catch (e) {
					error = e;
				}
			}
		};
		await Promise.all(Array.from({ length: limit }, () => workerLoop()));
		if (error) {
			throw error;
		}
	}

	private shouldUseDeltaScan(trigger: 'manual' | 'auto', hashCache: LocalHashCacheFile): boolean {
		if (!this.deltaLoaded || this.deltaDirtyPaths.size === 0) return false;
		if (this.deltaDirtyPaths.size > DELTA_SCAN_MAX_PATHS) return false;
		if (!hashCache || Object.keys(hashCache.files).length === 0) return false;
		const lastFullScan = hashCache.fullScanAt || 0;
		if (Date.now() - lastFullScan > FULL_SCAN_INTERVAL_MS) return false;
		return true;
	}

	private buildHashCacheFromLocalCurrent(localCurrent: Record<string, LocalFileState>, fullScanAt?: number): LocalHashCacheFile {
		const files: Record<string, LocalHashCacheEntry> = {};
		for (const [path, entry] of Object.entries(localCurrent)) {
			files[path] = {
				hash: entry.hash,
				modifiedTime: entry.modifiedTime,
				size: entry.size
			};
		}
		return {
			schemaVersion: 1,
			updatedAt: Date.now(),
			fullScanAt: fullScanAt || Date.now(),
			files
		};
	}

	private async scanLocalFiles(
		hashCache: LocalHashCacheFile,
		options?: { trigger?: 'manual' | 'auto'; forceFull?: boolean }
	): Promise<{ files: Record<string, LocalFileState>; cache: LocalHashCacheFile }> {
		const trigger = options?.trigger || 'manual';
		const useDelta = !options?.forceFull && this.shouldUseDeltaScan(trigger, hashCache);
		const result: Record<string, LocalFileState> = {};
		const nextCache: LocalHashCacheFile = {
			schemaVersion: 1,
			updatedAt: Date.now(),
			files: {},
			fullScanAt: hashCache.fullScanAt
		};

		if (useDelta) {
			const dirtyPaths = Array.from(this.deltaDirtyPaths).filter(path => !this.isPathExcluded(path));
			const dirtySet = new Set(dirtyPaths);
			for (const [path, cached] of Object.entries(hashCache.files)) {
				if (dirtySet.has(path) || this.isPathExcluded(path)) continue;
				result[path] = {
					hash: cached.hash,
					modifiedTime: cached.modifiedTime,
					size: cached.size
				};
				nextCache.files[path] = {
					hash: cached.hash,
					modifiedTime: cached.modifiedTime,
					size: cached.size
				};
			}

			await this.runWithConcurrency(dirtyPaths, HASH_CONCURRENCY, async (path) => {
				const localFile = this.app.vault.getAbstractFileByPath(path);
				let size = 0;
				let modifiedTime = 0;
				if (localFile instanceof TFile) {
					size = localFile.stat.size;
					modifiedTime = localFile.stat.mtime;
				} else {
					const stat = await this.app.vault.adapter.stat(path);
					if (!stat || stat.type !== 'file') return;
					size = stat.size;
					modifiedTime = stat.mtime;
				}

				const cached = hashCache.files[path];
				if (cached && cached.size === size && cached.modifiedTime === modifiedTime && cached.hash) {
					result[path] = {
						hash: cached.hash,
						modifiedTime: modifiedTime,
						size: size
					};
					nextCache.files[path] = {
						hash: cached.hash,
						modifiedTime: modifiedTime,
						size: size
					};
					return;
				}

				const content = localFile instanceof TFile
					? await this.app.vault.readBinary(localFile)
					: await this.app.vault.adapter.readBinary(path);
				const hash = this.computeHash(content);
				result[path] = {
					hash: hash,
					modifiedTime: modifiedTime,
					size: size
				};
				nextCache.files[path] = {
					hash: hash,
					modifiedTime: modifiedTime,
					size: size
				};
			});

			return { files: result, cache: nextCache };
		}

		const fileByPath = await this.buildLocalFileMap();
		const entries = Array.from(fileByPath.entries()).filter(([path]) => !this.isPathExcluded(path));
		await this.runWithConcurrency(entries, HASH_CONCURRENCY, async ([path, localFile]) => {
			let size = 0;
			let modifiedTime = 0;
			if (localFile instanceof TFile) {
				size = localFile.stat.size;
				modifiedTime = localFile.stat.mtime;
			} else {
				const stat = await this.app.vault.adapter.stat(path);
				if (!stat || stat.type !== 'file') return;
				size = stat.size;
				modifiedTime = stat.mtime;
			}

			const cached = hashCache.files[path];
			if (cached && cached.size === size && cached.modifiedTime === modifiedTime && cached.hash) {
				result[path] = {
					hash: cached.hash,
					modifiedTime: modifiedTime,
					size: size
				};
				nextCache.files[path] = {
					hash: cached.hash,
					modifiedTime: modifiedTime,
					size: size
				};
				return;
			}

			const content = localFile instanceof TFile
				? await this.app.vault.readBinary(localFile)
				: await this.app.vault.adapter.readBinary(path);
			const hash = this.computeHash(content);
			result[path] = {
				hash: hash,
				modifiedTime: modifiedTime,
				size: size
			};
			nextCache.files[path] = {
				hash: hash,
				modifiedTime: modifiedTime,
				size: size
			};
		});

		nextCache.fullScanAt = Date.now();
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

	private hasDiffChanges(diff: SyncDiff): boolean {
		return diff.renameLocal.length > 0
			|| diff.renameRemote.length > 0
			|| diff.toDownload.length > 0
			|| diff.toUpload.length > 0
			|| diff.toDeleteLocal.length > 0
			|| diff.toDeleteRemote.length > 0
			|| diff.conflicts.length > 0;
	}

	private getConflictPath(originalPath: string): string {
		const dot = originalPath.lastIndexOf('.');
		if (dot > 0) {
			const base = originalPath.slice(0, dot);
			const ext = originalPath.slice(dot);
			return `${base} (conflict copy: local)${ext}`;
		}
		return `${originalPath} (conflict copy: local)`;
	}

	async onload() {
		await this.loadSettings();
		this.setDebugEnabled(this.getDebugLoggingFromEnv());

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

	getSuggestedVaultName(): string {
		return this.settings.currentVaultName || this.getLocalVaultName();
	}

	getVaultOptions(): VaultMetaEntry[] {
		return this.getCachedVaultList();
	}

	async refreshVaultList(): Promise<void> {
		if (!this.settings.accessToken) return;
		const rootFolderId = await this.getRootFolderId();
		if (!rootFolderId) return;
		await this.ensureVaultsMeta(rootFolderId, true);
	}

	async applyVaultSelectionByName(): Promise<void> {
		await this.selectOrCreateVaultByName(this.settings.currentVaultName);
	}

	async applyVaultSelectionById(vaultId: string): Promise<void> {
		if (!this.settings.accessToken) return;
		const rootFolderId = await this.getRootFolderId();
		if (!rootFolderId) return;
		const meta = await this.ensureVaultsMeta(rootFolderId);
		const entry = meta.vaults.find(vault => vault.id === vaultId);
		if (entry) {
			await this.setCurrentVault(entry);
		} else {
			new Notice("Selected vault is no longer available. Refresh the vault list.");
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
			await this.getRootFolderId();
			await this.refreshVaultList();

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

	async getRootFolderId(): Promise<string> {
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
			let folderId = await this.gdrive.getFolderId(ROOT_FOLDER_NAME);
			if (!folderId) {
				new Notice(`Creating remote folder '${ROOT_FOLDER_NAME}'...`);
				this.debugLog("Remote folder not found, creating");
				folderId = await this.gdrive.createFolder(ROOT_FOLDER_NAME);
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

		if (!this.tryBeginSyncAction('sync', trigger)) {
			return;
		}
		this.setSyncingIndicator(true);
		try {
			this.debugLog("Sync started");
			const rootFolderId = await this.getRootFolderId();
			if (!rootFolderId) return;

			const localState = await this.loadLocalState();
			const localVaultsMeta = await this.loadLocalVaultsMeta(rootFolderId);
			const resolvedVaultId = this.settings.currentVaultId
				|| localVaultsMeta?.vaults.find(vault => vault.name === (this.settings.currentVaultName || this.getLocalVaultName()).trim())?.id
				|| '';

			if (
				resolvedVaultId &&
				localVaultsMeta &&
				localVaultsMeta.remoteFileId &&
				localVaultsMeta.remoteVersion &&
				!this.hasLocalDelta()
			) {
				const currentVersion = await this.gdrive.getFileVersion(localVaultsMeta.remoteFileId);
				if (currentVersion && (Number(currentVersion) - 1) === Number(localVaultsMeta.remoteVersion)) {
					this.debugLog("Sync skipped (local state matches cached vaults meta)", {
						vaultId: resolvedVaultId,
						lastSyncTimestamp: localState.lastSyncTimestamp
					});
					new Notice("No changes to sync.");
					return;
				}
			}

			const folderId = resolvedVaultId || await this.getVaultFolderId(rootFolderId);
			if (!folderId) return;
			await this.loadFolderPathCache(folderId);

			// const vaultsMeta = await this.ensureVaultsMeta(rootFolderId);
			// const vaultEntry = vaultsMeta.vaults.find(vault => vault.id === folderId);

			if (localState.rootFolderId && localState.rootFolderId !== folderId) {
				const resetState: LocalStateFile = {
					schemaVersion: 1,
					rootFolderId: folderId,
					lastSyncTimestamp: 0,
					lastSyncByDevice: '',
					files: {}
				};
				await this.saveLocalState(resetState);
				Object.assign(localState, resetState);
			}

			const remoteMetaInfo = await this.loadRemoteMetadata(folderId, { skipEncryptionTester: true });
			let remoteMetadata = remoteMetaInfo.metadata;
			let metadataFileId = remoteMetaInfo.fileId;
			const metadataVersion = remoteMetaInfo.version;
			let metadataEtag = remoteMetaInfo.etag;

			if (!remoteMetadata) {
				this.debugLog("No remote metadata found, rebuilding from Drive listing");
				remoteMetadata = await this.buildRemoteMetadataFromDrive(folderId);
				metadataFileId = await this.gdrive.uploadFile(
					METADATA_FILE_NAME,
					JSON.stringify(remoteMetadata, null, 2),
					folderId,
					metadataFileId || undefined,
					{ mimeType: 'application/json' }
				);
				metadataEtag = null;
			}

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache, { trigger });
			let localCurrent = scan.files;
			let hashCacheState = scan.cache;

			this.debugLog("Sync file counts", {
				remote: Object.keys(remoteMetadata.files).length,
				local: Object.keys(localCurrent).length
			});

			new Notice("Syncing...");

			const remoteMetadataForSync = this.filterMetadataBySyncRules(remoteMetadata);
			const localStateForSync = this.filterMetadataBySyncRules(localState);
			const localCurrentForSync = this.filterLocalCurrentBySyncRules(localCurrent);
			const diff = this.buildDiff(remoteMetadataForSync, localStateForSync, localCurrentForSync);
			const hasChanges = this.hasDiffChanges(diff);
			const totalSteps = diff.renameLocal.length
				+ diff.conflicts.length
				+ diff.toDownload.length
				+ diff.toDeleteLocal.length
				+ diff.renameRemote.length
				+ diff.toUpload.length
				+ diff.toDeleteRemote.length;
			let completedSteps = 0;
			const advanceProgress = () => {
				completedSteps += 1;
				this.updateSyncProgress(completedSteps, totalSteps);
			};
			if (totalSteps > 0) {
				this.updateSyncProgress(0, totalSteps);
			} else {
				this.updateSyncProgress(0, 0);
			}

			await this.ensureRemoteFolders(
				folderId,
				[
					...diff.renameRemote.map(rename => this.getPathDir(rename.to)),
					...diff.toUpload.map(path => this.getPathDir(path))
				]
			);

			for (const rename of diff.renameLocal) {
				const localFile = this.app.vault.getAbstractFileByPath(rename.from);
				if (localFile instanceof TFile) {
					await this.app.vault.rename(localFile, rename.to);
					localCurrent[rename.to] = localCurrent[rename.from];
					delete localCurrent[rename.from];
				}
				advanceProgress();
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
				advanceProgress();
			}

			const configPrefix = this.getConfigDirPrefix();

			await this.runWithConcurrency(diff.toDownload, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const remoteEntry = remoteMetadata.files[path];
					if (!remoteEntry || remoteEntry.isDeleted || !remoteEntry.id) {
						return;
					}
					const content = await this.gdrive.downloadFile(remoteEntry.id);
					const decrypted = await this.decryptContentOrThrow(content);
					await this.ensureLocalFolderForPath(path);
					const localFile = this.app.vault.getAbstractFileByPath(path);
					if (localFile instanceof TFile) {
						await this.app.vault.modifyBinary(localFile, decrypted);
					} else if (path.startsWith(configPrefix)) {
						await this.app.vault.adapter.writeBinary(path, decrypted);
					} else {
						await this.app.vault.createBinary(path, decrypted);
					}
					const hash = remoteEntry.hash || this.computeHash(decrypted);
					localCurrent[path] = {
						hash: hash,
						modifiedTime: remoteEntry.modifiedTime || Date.now(),
						size: remoteEntry.size || decrypted.byteLength
					};
				} finally {
					advanceProgress();
				}
			});

			await this.runWithConcurrency(diff.toDeleteLocal, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const localFile = this.app.vault.getAbstractFileByPath(path);
					if (localFile instanceof TFile) {
						await this.app.vault.delete(localFile);
						delete localCurrent[path];
					} else if (path.startsWith(configPrefix)) {
						await this.app.vault.adapter.remove(path);
						delete localCurrent[path];
					}
				} finally {
					advanceProgress();
				}
			});

			for (const rename of diff.renameRemote) {
				const entryPath = Object.keys(remoteMetadata.files).find(p => remoteMetadata.files[p].id === rename.id);
				const newParentPath = this.getPathDir(rename.to);
				const newName = this.getPathBase(rename.to);
				const newParentId = await this.gdrive.ensureFolderPath(folderId, newParentPath);
				let oldParentId = entryPath ? remoteMetadata.files[entryPath]?.parentId : undefined;
				if (!oldParentId) {
					const parents = await this.gdrive.getFileParents(rename.id);
					oldParentId = parents.length > 0 ? parents[0] : undefined;
				}
				await this.gdrive.moveFile(rename.id, newName, newParentId, oldParentId);
				if (entryPath && entryPath !== rename.to) {
					remoteMetadata.files[rename.to] = {
						...remoteMetadata.files[entryPath],
						parentId: newParentId
					};
					delete remoteMetadata.files[entryPath];
				}
				advanceProgress();
			}

			await this.runWithConcurrency(diff.toUpload, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const localFile = this.app.vault.getAbstractFileByPath(path);
					const content = await this.readLocalFileForUpload(path, localFile instanceof TFile ? localFile : null);
					const remoteEntry = remoteMetadata.files[path];
					const remoteId = remoteEntry && !remoteEntry.isDeleted ? remoteEntry.id : undefined;
					const uploaded = await this.gdrive.uploadFileByPath(folderId, path, content, remoteId);
					remoteMetadata.files[path] = {
						id: uploaded.id,
						parentId: uploaded.parentId,
						hash: localCurrent[path].hash,
						modifiedTime: localCurrent[path].modifiedTime,
						size: localCurrent[path].size,
						isDeleted: false,
						mimeType: 'text/markdown'
					};
				} finally {
					advanceProgress();
				}
			});

			await this.runWithConcurrency(diff.toDeleteRemote, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const remoteEntry = remoteMetadata.files[path];
					if (remoteEntry?.id) {
						await this.gdrive.deleteFile(remoteEntry.id);
						remoteMetadata.files[path].isDeleted = true;
					}
				} finally {
					advanceProgress();
				}
			});

			if (hasChanges) {
				remoteMetadata.lastSyncTimestamp = Date.now();
				remoteMetadata.lastSyncByDevice = this.settings.userName || 'unknown';
				remoteMetadata.rootFolderId = folderId;
				await this.applyEncryptionTester(remoteMetadata);
			}

			try {
				if (hasChanges) {
					if (metadataFileId && metadataVersion) {
						const currentVersion = await this.gdrive.getFileVersion(metadataFileId);
						if (currentVersion && currentVersion !== metadataVersion) {
							new Notice("Sync interrupted: remote metadata changed. Please sync again.");
							this.debugLog("Metadata version precondition failed", {
								expected: metadataVersion,
								actual: currentVersion
							});
							return;
						}
					}

					const uploadOptions = metadataEtag
						? { mimeType: 'application/json', ifMatch: metadataEtag }
						: { mimeType: 'application/json' };
					metadataFileId = await this.gdrive.uploadFile(
						METADATA_FILE_NAME,
						JSON.stringify(remoteMetadata, null, 2),
						folderId,
						metadataFileId || undefined,
						uploadOptions
					);
					metadataEtag = null;
				}
			} catch (e: any) {
				if (String(e.message || '').includes('412')) {
					new Notice("Sync interrupted: remote metadata changed. Please sync again.");
					this.debugLog("Metadata upload precondition failed", e);
					return;
				}
				throw e;
			}

			await this.saveLocalState(remoteMetadata);
			await this.updateVaultMetaOnSync(rootFolderId, folderId);

			const nextCache = this.buildHashCacheFromLocalCurrent(localCurrent, hashCacheState.fullScanAt);
			await this.saveLocalHashCache(nextCache);
			this.clearDelta();

			new Notice("Sync complete!");
			this.debugLog("Sync complete");
		} catch (e: any) {
			new Notice(`Sync failed: ${e.message}`);
			this.debugLog("Sync failed", e);
		} finally {
			this.endSyncAction();
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

		if (!this.tryBeginSyncAction('forcePush')) {
			return;
		}

		try {
			this.setSyncingIndicator(true);
			this.debugLog("Force push started");
			const folderId = await this.getVaultFolderId();
			if (!folderId) return;
			await this.loadFolderPathCache(folderId);
			const remoteMetaInfo = await this.loadRemoteMetadata(folderId, { skipEncryptionTester: true });
			let remoteMetadata = remoteMetaInfo.metadata;
			const metadataFileId = remoteMetaInfo.fileId;
			let metadataEtag = remoteMetaInfo.etag;
			if (!remoteMetadata) {
				remoteMetadata = await this.buildRemoteMetadataFromDrive(folderId);
				metadataEtag = null;
			}

			const remoteFiles = this.filterRemoteVaultFilesForSync(await this.getRemoteFilesForForceOps(folderId));
			const localFileMap = await this.buildLocalFileMap();
			const localPaths = Array.from(localFileMap.keys()).filter(path => !this.isPathExcluded(path));
			const localPathSet = new Set(localPaths);
			const remoteFileByPath = new Map<string, any>();
			for (const remoteFile of remoteFiles) {
				const remotePath = this.getRemoteFilePath(remoteFile);
				if (remotePath) {
					remoteFileByPath.set(remotePath, remoteFile);
				}
			}
			const remoteDeleteCandidates = remoteFiles.filter(remoteFile => {
				const remotePath = this.getRemoteFilePath(remoteFile);
				if (!remotePath || localPathSet.has(remotePath)) return false;
				return remoteFile.capabilities?.canDelete !== false;
			});
			const uploadPaths = localPaths.filter(path => {
				const remoteFile = remoteFileByPath.get(path);
				return !remoteFile || remoteFile.capabilities?.canEdit !== false;
			});
			const totalSteps = remoteDeleteCandidates.length + uploadPaths.length;
			let completedSteps = 0;
			const advanceProgress = () => {
				completedSteps += 1;
				this.updateSyncProgress(completedSteps, totalSteps);
			};
			if (totalSteps > 0) {
				this.updateSyncProgress(0, totalSteps);
			} else {
				this.updateSyncProgress(0, 0);
			}

			await this.ensureRemoteFolders(folderId, uploadPaths.map(path => this.getPathDir(path)));

			this.debugLog("Force push counts", { folderId, remote: remoteFiles.length, local: localPaths.length });

			new Notice("Force pushing local to remote...");

			const uploadedIds: Record<string, { id: string; parentId: string }> = {};

			// Delete remote files that don't exist locally
			await this.runWithConcurrency(remoteDeleteCandidates, SYNC_IO_CONCURRENCY, async (remoteFile) => {
				try {
					const remotePath = this.getRemoteFilePath(remoteFile);
					if (remotePath) {
						await this.gdrive.deleteFile(remoteFile.id);
					}
				} finally {
					advanceProgress();
				}
			});

			await this.runWithConcurrency(uploadPaths, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const localFile = localFileMap.get(path) || null;
					const remoteFile = remoteFileByPath.get(path);
					const content = await this.readLocalFileForUpload(path, localFile instanceof TFile ? localFile : null);
					const uploaded = await this.gdrive.uploadFileByPath(folderId, path, content, remoteFile?.id);
					uploadedIds[path] = { id: uploaded.id, parentId: uploaded.parentId };
				} finally {
					advanceProgress();
				}
			});

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache, { trigger: 'manual', forceFull: true });
			const localCurrent = scan.files;
			const hashCacheState = scan.cache;
			const baseMetadata: RemoteMetadataFile = remoteMetadata || {
				schemaVersion: 1,
				rootFolderId: folderId,
				lastSyncTimestamp: 0,
				lastSyncByDevice: '',
				files: {}
			};
			const newMetadata: RemoteMetadataFile = {
				...baseMetadata,
				rootFolderId: folderId,
				lastSyncTimestamp: Date.now(),
				lastSyncByDevice: this.settings.userName || 'unknown',
				files: { ...baseMetadata.files }
			};

			for (const [path, entry] of Object.entries(newMetadata.files)) {
				if (this.isPathExcluded(path)) continue;
				if (!localCurrent[path]) {
					newMetadata.files[path] = {
						...entry,
						isDeleted: true
					};
				}
			}

			for (const [path, entry] of Object.entries(localCurrent)) {
				newMetadata.files[path] = {
					id: uploadedIds[path]?.id,
					parentId: uploadedIds[path]?.parentId,
					hash: entry.hash,
					modifiedTime: entry.modifiedTime,
					size: entry.size,
					isDeleted: false,
					mimeType: 'text/markdown'
				};
			}

			await this.applyEncryptionTester(newMetadata);
			const uploadOptions = metadataEtag
				? { mimeType: 'application/json', ifMatch: metadataEtag }
				: { mimeType: 'application/json' };
			await this.gdrive.uploadFile(
				METADATA_FILE_NAME,
				JSON.stringify(newMetadata, null, 2),
				folderId,
				metadataFileId || undefined,
				uploadOptions
			);

			await this.saveLocalState(newMetadata);
			await this.saveLocalHashCache(hashCacheState);
			this.clearDelta();
			const rootFolderId = await this.getRootFolderId();
			if (rootFolderId) {
				await this.updateVaultMetaOnSync(rootFolderId, folderId);
			}

			new Notice("Force push complete!");
			this.debugLog("Force push complete");
		} catch (e: any) {
			new Notice(`Force push failed: ${e.message}`);
			this.debugLog("Force push failed", e);
		} finally {
			this.endSyncAction();
			this.setSyncingIndicator(false);
		}
	}

	async forcePull() {
		if (!this.settings.accessToken) {
			new Notice("Please authenticate in settings first.");
			return;
		}

		if (!this.tryBeginSyncAction('forcePull')) {
			return;
		}

		try {
			this.setSyncingIndicator(true);
			this.debugLog("Force pull started");
			const folderId = await this.getVaultFolderId();
			if (!folderId) return;

			const remoteMetaInfo = await this.loadRemoteMetadata(folderId);
			let metadataFileId = remoteMetaInfo.fileId;
			let metadataEtag = remoteMetaInfo.etag;

			const remoteFiles = this.filterRemoteVaultFilesForSync(await this.getRemoteFilesForForceOps(folderId));
			this.debugLog("Force pull remote count", remoteFiles.length);

			new Notice("Force pulling remote to local...");

			const localFileMap = await this.buildLocalFileMap();
			const localPaths = Array.from(localFileMap.keys()).filter(path => !this.isPathExcluded(path));
			const remoteFilesWithPath = remoteFiles
				.map(file => ({ file, path: this.getRemoteFilePath(file) }))
				.filter(entry => !!entry.path);
			const remotePathSet = new Set(remoteFilesWithPath.map(entry => entry.path as string));
			const localPathsToDelete = localPaths.filter(path => !remotePathSet.has(path));
			const totalSteps = localPathsToDelete.length + remoteFilesWithPath.length;
			let completedSteps = 0;
			const advanceProgress = () => {
				completedSteps += 1;
				this.updateSyncProgress(completedSteps, totalSteps);
			};
			if (totalSteps > 0) {
				this.updateSyncProgress(0, totalSteps);
			} else {
				this.updateSyncProgress(0, 0);
			}
			const configPrefix = this.getConfigDirPrefix();
			// Delete local files that don't exist remotely
			await this.runWithConcurrency(localPathsToDelete, SYNC_IO_CONCURRENCY, async (path) => {
				try {
					const localFile = localFileMap.get(path) || null;
					if (localFile instanceof TFile) {
						await this.app.vault.delete(localFile);
					} else {
						await this.app.vault.adapter.remove(path);
					}
				} finally {
					advanceProgress();
				}
			});

			await this.runWithConcurrency(remoteFilesWithPath, SYNC_IO_CONCURRENCY, async (entry) => {
				try {
					const remoteFile = entry.file;
					const remotePath = entry.path as string;
					const content = await this.gdrive.downloadFile(remoteFile.id);
					const decrypted = await this.decryptContentOrThrow(content);
					await this.ensureLocalFolderForPath(remotePath);
					const localFile = this.app.vault.getAbstractFileByPath(remotePath);

					if (localFile instanceof TFile) {
						await this.app.vault.modifyBinary(localFile, decrypted);
					} else if (remotePath.startsWith(configPrefix)) {
						await this.app.vault.adapter.writeBinary(remotePath, decrypted);
					} else {
						await this.app.vault.createBinary(remotePath, decrypted);
					}
				} finally {
					advanceProgress();
				}
			});

			const newMetadata = await this.buildRemoteMetadataFromDrive(folderId);
			newMetadata.lastSyncTimestamp = Date.now();
			newMetadata.lastSyncByDevice = this.settings.userName || 'unknown';
			await this.applyEncryptionTester(newMetadata);
			const uploadOptions = metadataEtag
				? { mimeType: 'application/json', ifMatch: metadataEtag }
				: { mimeType: 'application/json' };
			await this.gdrive.uploadFile(
				METADATA_FILE_NAME,
				JSON.stringify(newMetadata, null, 2),
				folderId,
				metadataFileId || undefined,
				uploadOptions
			);

			const hashCache = await this.loadLocalHashCache();
			const scan = await this.scanLocalFiles(hashCache, { trigger: 'manual', forceFull: true });
			const hashCacheState = scan.cache;

			await this.saveLocalState(newMetadata);
			await this.saveLocalHashCache(hashCacheState);
			this.clearDelta();
			const rootFolderId = await this.getRootFolderId();
			if (rootFolderId) {
				await this.updateVaultMetaOnSync(rootFolderId, folderId);
			}

			new Notice("Force pull complete!");
			this.debugLog("Force pull complete");
		} catch (e: any) {
			new Notice(`Force pull failed: ${e.message}`);
			this.debugLog("Force pull failed", e);
		} finally {
			this.endSyncAction();
			this.setSyncingIndicator(false);
		}
	}

	async logout() {
		this.debugLog("Logging out");
		this.settings.accessToken = '';
		this.settings.refreshToken = '';
		this.settings.userName = '';
		this.settings.remoteFolderId = '';
		this.settings.currentVaultId = '';
		await this.saveSettings();
		this.gdrive.setTokens('', '');
		this.vaultsMetaCache = null;
		this.vaultsMetaFileId = null;
		this.vaultsMetaRootId = null;
		this.vaultsMetaVersion = null;
		this.resetVaultScopedState();
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

class EncryptionKeyChangeModal extends Modal {
	onConfirm: () => void;
	onCancel: () => void;
	private didResolve = false;

	constructor(app: App, onConfirm: () => void, onCancel: () => void) {
		super(app);
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Encryption key changed" });
		contentEl.createEl("p", { text: "Changing the encryption key requires a force push to keep files consistent." });

		const btnContainer = contentEl.createDiv({ cls: "sync-drive-modal-buttons" });
		const forceBtn = btnContainer.createEl("button", { text: "Force Push", cls: "mod-cta" });
		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });

		forceBtn.onclick = () => {
			this.didResolve = true;
			this.close();
			this.onConfirm();
		};
		cancelBtn.onclick = () => {
			this.didResolve = true;
			this.close();
			this.onCancel();
		};
	}

	onClose() {
		if (!this.didResolve) {
			this.onCancel();
		}
		this.contentEl.empty();
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
		this.plugin.setSyncActionStateListener(null);
		this.plugin.setSyncProgressListener(null);

		containerEl.createEl('h2', { text: 'Sync Drive Settings' });

		const gateMessage = 'please select or type in a vault name.';
		const gatedSettings: Setting[] = [];
		let encryptionKeyInputEl: HTMLInputElement | null = null;
		let encryptionKeyPromptOpen = false;
		let pendingEncryptionKey: string | null = null;
		let syncNowButtonEl: HTMLButtonElement | null = null;
		let syncNowButtonText = 'Sync now';
		let forcePushButtonEl: HTMLButtonElement | null = null;
		let forcePushButtonText = 'Force push';
		let forcePullButtonEl: HTMLButtonElement | null = null;
		let forcePullButtonText = 'Force pull';
		let syncProgressWrapEl: HTMLDivElement | null = null;
		let syncProgressBarEl: HTMLProgressElement | null = null;
		let syncProgressTextEl: HTMLDivElement | null = null;
		const hasVaultSelection = () => {
			const trimmedName = (this.plugin.settings.currentVaultName || '').trim();
			return trimmedName.length > 0 || !!this.plugin.settings.currentVaultId;
		};
		const registerVaultGate = (setting: Setting) => {
			gatedSettings.push(setting);
			return setting;
		};
		const setSyncActionButtonsEnabled = (enabled: boolean) => {
			const canEnable = enabled && hasVaultSelection();
			if (syncNowButtonEl) syncNowButtonEl.disabled = !canEnable;
			if (forcePushButtonEl) forcePushButtonEl.disabled = !canEnable;
			if (forcePullButtonEl) forcePullButtonEl.disabled = !canEnable;
		};
		const setActionButtonLoading = (
			buttonEl: HTMLButtonElement | null,
			loading: boolean,
			loadingText: string,
			defaultText: string
		) => {
			if (!buttonEl) return;
			if (loading) {
				buttonEl.dataset.loading = 'true';
				buttonEl.classList.add('sync-drive-button-loading');
				buttonEl.textContent = loadingText;
				return;
			}
			buttonEl.dataset.loading = 'false';
			buttonEl.classList.remove('sync-drive-button-loading');
			buttonEl.textContent = defaultText;
		};
		const applySyncActionUiState = (inProgress: boolean, action: SyncActionType | null) => {
			setSyncActionButtonsEnabled(!inProgress);
			if (!inProgress) {
				setActionButtonLoading(syncNowButtonEl, false, '', syncNowButtonText);
				setActionButtonLoading(forcePushButtonEl, false, '', forcePushButtonText);
				setActionButtonLoading(forcePullButtonEl, false, '', forcePullButtonText);
				return;
			}
			setActionButtonLoading(syncNowButtonEl, action === 'sync', 'Syncing...', syncNowButtonText);
			setActionButtonLoading(forcePushButtonEl, action === 'forcePush', 'Force pushing...', forcePushButtonText);
			setActionButtonLoading(forcePullButtonEl, action === 'forcePull', 'Force pulling...', forcePullButtonText);
		};
		const applySyncProgressUiState = (state: SyncProgressState) => {
			if (!syncProgressWrapEl || !syncProgressBarEl || !syncProgressTextEl) return;
			const { current, total, action } = state;
			const shouldShow = !!action;
			syncProgressWrapEl.style.display = shouldShow ? 'flex' : 'none';
			if (!shouldShow) return;
			const safeTotal = Math.max(total, 1);
			const safeCurrent = Math.min(current, total);
			syncProgressBarEl.max = safeTotal;
			syncProgressBarEl.value = safeCurrent;
			syncProgressTextEl.textContent = `${safeCurrent}/${total}`;
		};
		const maybePromptEncryptionKeyChange = () => {
			if (encryptionKeyPromptOpen) return;
			const current = this.plugin.settings.encryptionKey;
			if (!encryptionKeyInputEl || !encryptionKeyInputEl.isConnected) return;
			if (pendingEncryptionKey === null || pendingEncryptionKey === current) return;
			encryptionKeyPromptOpen = true;
			const nextValue = pendingEncryptionKey;
			new EncryptionKeyChangeModal(
				this.app,
				async () => {
					this.plugin.settings.encryptionKey = nextValue;
					await this.plugin.saveSettings();
					if (encryptionKeyInputEl) {
						encryptionKeyInputEl.value = nextValue;
					}
					encryptionKeyPromptOpen = false;
					await this.plugin.forcePush();
				},
				() => {
					if (encryptionKeyInputEl) {
						encryptionKeyInputEl.value = current;
					}
					pendingEncryptionKey = current;
					encryptionKeyPromptOpen = false;
				}
			).open();
		};

		const authHeaderText = this.plugin.settings.userName
			? `Authentication (Logged in as: ${this.plugin.settings.userName})`
			: 'Authentication';

		containerEl.createEl('h3', { text: authHeaderText });

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

		if (this.plugin.isDebugEnabled()) {
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

		if (this.plugin.settings.accessToken) {
			containerEl.createEl('h3', { text: 'Vault' });

			const vaults = this.plugin.getVaultOptions();
			const suggestedVaultName = this.plugin.getSuggestedVaultName();
			const currentVault = this.plugin.settings.currentVaultId
				? vaults.find(vault => vault.id === this.plugin.settings.currentVaultId)
				: null;
			const displayVaultName = currentVault?.name || suggestedVaultName;
			const currentVaultLabel = this.plugin.settings.currentVaultId
				? displayVaultName
				: `${displayVaultName} (not selected)`;
			// containerEl.createEl('p', { text: `Current vault: ${currentVaultLabel}`, cls: 'sync-drive-user-info' });

			new Setting(containerEl)
				.setName('Vault name')
				.setDesc('Name to use when creating or selecting a vault.')
				.addText(text => {
					const inputEl = text.inputEl;
					const iconButton = document.createElement('button');
					iconButton.type = 'button';
					iconButton.className = 'clickable-icon sync-drive-vault-picker';
					iconButton.setAttribute('aria-label', 'Select vault');
					iconButton.setAttribute('title', 'Select vault');
					setIcon(iconButton, 'settings');
					const inputParent = inputEl.parentElement;
					if (inputParent) {
						inputParent.insertBefore(iconButton, inputEl);
					}
					iconButton.addEventListener('click', async (event) => {
						if (iconButton.dataset.loading === 'true') {
							return;
						}
						iconButton.dataset.loading = 'true';
						iconButton.disabled = true;

						const loadingMenu = new ObsidianMenu();
						loadingMenu.addItem(item => item.setTitle('Loading vaults...').setDisabled(true));
						loadingMenu.showAtMouseEvent(event as MouseEvent);

						try {
							await this.plugin.refreshVaultList();
							const availableVaults = this.plugin.getVaultOptions();
							loadingMenu.close();

							const menu = new ObsidianMenu();
							if (availableVaults.length === 0) {
								menu.addItem(item => item.setTitle('No vaults found').setDisabled(true));
							} else {
								for (const vault of availableVaults) {
									menu.addItem(item => {
										item.setTitle(vault.name);
										if (vault.id === this.plugin.settings.currentVaultId) {
											item.setIcon('check');
										}
										item.onClick(async () => {
											await this.plugin.applyVaultSelectionById(vault.id);
											this.display();
										});
									});
								}
							}
							menu.showAtMouseEvent(event as MouseEvent);
						} finally {
							iconButton.dataset.loading = 'false';
							iconButton.disabled = false;
						}
					});

					text
						.setPlaceholder(suggestedVaultName)
						.setValue(this.plugin.settings.currentVaultName || '')
						.onChange(async (value) => {
							this.plugin.settings.currentVaultName = value.trim();
							this.plugin.settings.currentVaultId = '';
							await this.plugin.saveSettings();
							applyVaultGate();
						});
				});

			registerVaultGate(new Setting(containerEl))
				.setName('Encryption key')
				.setDesc('Encrypt files before upload and decrypt after download. Leave blank to disable. If you change this key, run a force push so all files are encrypted with the same key.')
				.addText(text => {
					text.inputEl.type = 'password';
					encryptionKeyInputEl = text.inputEl;
					text
						.setPlaceholder('Leave blank to disable')
						.setValue(this.plugin.settings.encryptionKey)
						.onChange(async (value) => {
							pendingEncryptionKey = value;
						});
					text.inputEl.addEventListener('blur', () => {
						maybePromptEncryptionKeyChange();
					});
				});

			const manualSyncSetting = registerVaultGate(new Setting(containerEl))
				.setName('Manual sync')
				.setDesc('Run sync actions on demand.')
				.addButton(button => {
					button
						.setButtonText('Sync now')
						.setCta()
						.onClick(async () => {
							await this.plugin.sync();
						});
					syncNowButtonEl = button.buttonEl;
					syncNowButtonText = syncNowButtonEl.textContent || syncNowButtonText;
				})
				.addButton(button => {
					button
						.setButtonText('Force push')
						.onClick(async () => {
							await this.plugin.forcePush();
						});
					forcePushButtonEl = button.buttonEl;
					forcePushButtonText = forcePushButtonEl.textContent || forcePushButtonText;
				})
				.addButton(button => {
					button
						.setButtonText('Force pull')
						.onClick(async () => {
							await this.plugin.forcePull();
						});
					forcePullButtonEl = button.buttonEl;
					forcePullButtonText = forcePullButtonEl.textContent || forcePullButtonText;
				});

			manualSyncSetting.controlEl.addClass('sync-drive-manual-controls');
			syncProgressWrapEl = manualSyncSetting.controlEl.createDiv({ cls: 'sync-drive-manual-progress' });
			syncProgressBarEl = syncProgressWrapEl.createEl('progress', { cls: 'sync-drive-manual-progress-bar' });
			syncProgressTextEl = syncProgressWrapEl.createEl('div', { cls: 'sync-drive-manual-progress-text' });
			syncProgressWrapEl.style.display = 'none';

			this.plugin.setSyncActionStateListener((inProgress, action) => {
				if (syncNowButtonEl && !syncNowButtonEl.isConnected) return;
				applySyncActionUiState(inProgress, action);
			});
			this.plugin.setSyncProgressListener((state) => {
				if (syncProgressWrapEl && !syncProgressWrapEl.isConnected) return;
				applySyncProgressUiState(state);
			});
			applySyncActionUiState(this.plugin.isSyncActionInProgress(), this.plugin.getSyncActionType());
			applySyncProgressUiState(this.plugin.getSyncProgressState());
		}

		let autoSyncInputEl: HTMLInputElement | null = null;
		let autoSyncDropdownEl: HTMLSelectElement | null = null;
		const setAutoSyncControlsEnabled = (enabled: boolean) => {
			const canEnable = enabled && hasVaultSelection();
			if (autoSyncInputEl) autoSyncInputEl.disabled = !canEnable;
			if (autoSyncDropdownEl) autoSyncDropdownEl.disabled = !canEnable;
		};
		const applyVaultGate = () => {
			const isEnabled = hasVaultSelection();
			for (const setting of gatedSettings) {
				setting.setDisabled(!isEnabled);
				if (!isEnabled) {
					setting.settingEl.setAttribute('title', gateMessage);
				} else {
					setting.settingEl.removeAttribute('title');
				}
			}
			setAutoSyncControlsEnabled(this.plugin.settings.autoSyncEnabled);
			applySyncActionUiState(this.plugin.isSyncActionInProgress(), this.plugin.getSyncActionType());
		};

		registerVaultGate(new Setting(containerEl))
			.setName('Auto sync')
			.setDesc('Automatically sync on an interval.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						setAutoSyncControlsEnabled(value);
					});
			})
			.addText(text => {
				autoSyncInputEl = text.inputEl;
				text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.autoSyncIntervalValue))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (!Number.isFinite(parsed) || parsed <= 0) return;
						this.plugin.settings.autoSyncIntervalValue = parsed;
						await this.plugin.saveSettings();
					});
				setAutoSyncControlsEnabled(this.plugin.settings.autoSyncEnabled);
			})
			.addDropdown(dropdown => {
				autoSyncDropdownEl = dropdown.selectEl;
				dropdown
					.addOption('minutes', 'Minutes')
					.addOption('seconds', 'Seconds')
					.setValue(this.plugin.settings.autoSyncIntervalUnit)
					.onChange(async (value: string) => {
						if (value !== 'seconds' && value !== 'minutes') return;
						this.plugin.settings.autoSyncIntervalUnit = value;
						await this.plugin.saveSettings();
					});
				setAutoSyncControlsEnabled(this.plugin.settings.autoSyncEnabled);
			});

		containerEl.createEl('h3', { text: 'Selective Sync' });

		registerVaultGate(new Setting(containerEl))
			.setName('Sync images')
			.setDesc('Include image files (png, jpg, gif, svg, etc).')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncImages)
					.onChange(async (value) => {
						this.plugin.settings.syncImages = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Sync audio')
			.setDesc('Include audio files (mp3, wav, m4a, etc).')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncAudio)
					.onChange(async (value) => {
						this.plugin.settings.syncAudio = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Sync videos')
			.setDesc('Include video files (mp4, mov, mkv, etc).')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncVideos)
					.onChange(async (value) => {
						this.plugin.settings.syncVideos = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Sync PDFs')
			.setDesc('Include PDF files.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncPdfs)
					.onChange(async (value) => {
						this.plugin.settings.syncPdfs = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Excluded folders')
			.setDesc('Comma or newline separated folder paths to skip (relative to the vault).')
			.addTextArea(text => {
				text
					.setPlaceholder('Templates/\nArchive/')
					.setValue(this.plugin.settings.excludedFolders)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Exclude patterns')
			.setDesc('Glob patterns or regex (wrap regex with /.../).')
			.addTextArea(text => {
				text
					.setPlaceholder('*.log\n/.*\\/drafts\\/.*/')
					.setValue(this.plugin.settings.excludedPatterns)
					.onChange(async (value) => {
						this.plugin.settings.excludedPatterns = value;
						await this.plugin.saveSettings();
					});
			});


		containerEl.createEl('h3', { text: 'Settings Sync' });

		registerVaultGate(new Setting(containerEl))
			.setName('Appearance settings')
			.setDesc('Sync dark mode, theme, and enabled snippets.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncAppearanceSettings)
					.onChange(async (value) => {
						this.plugin.settings.syncAppearanceSettings = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Themes and snippets')
			.setDesc('Sync themes folder and snippets folder.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncThemesAndSnippets)
					.onChange(async (value) => {
						this.plugin.settings.syncThemesAndSnippets = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Plugins')
			.setDesc('Sync plugins except Sync Drive itself.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncPlugins)
					.onChange(async (value) => {
						this.plugin.settings.syncPlugins = value;
						await this.plugin.saveSettings();
					});
			});

		registerVaultGate(new Setting(containerEl))
			.setName('Hotkeys')
			.setDesc('Sync custom hotkey mappings.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.syncHotkeys)
					.onChange(async (value) => {
						this.plugin.settings.syncHotkeys = value;
						await this.plugin.saveSettings();
					});
			});

		applyVaultGate();
	}
}
