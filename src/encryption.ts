import { Base64Utils } from './utils/base64';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

const ENCRYPTION_MAGIC = textEncoder.encode('SDENC1');
const ENCRYPTION_TESTER_TEXT = 'encrypt_tester';
const ENCRYPTION_SALT_BYTES = 16;
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTION_TAG_BYTES = 16;
const ENCRYPTION_ITERATIONS = 100000;

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => Base64Utils.encode(buffer);
const base64ToArrayBuffer = (base64: string): ArrayBuffer => Base64Utils.decode(base64);

const toArrayBuffer = (data: Uint8Array): ArrayBuffer => {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return copy.buffer;
};

const getWebCrypto = (): Crypto => {
	if (globalThis.crypto && globalThis.crypto.subtle) {
		return globalThis.crypto;
	}
	throw new Error('WebCrypto is not available in this environment.');
};

const randomBytes = (size: number): Uint8Array => {
	const bytes = new Uint8Array(size);
	getWebCrypto().getRandomValues(bytes);
	return bytes;
};

const deriveEncryptionKey = async (key: string, salt: Uint8Array): Promise<CryptoKey> => {
	const crypto = getWebCrypto();
	const baseKey = await crypto.subtle.importKey(
		'raw',
		textEncoder.encode(key),
		'PBKDF2',
		false,
		['deriveKey']
	);
	const saltBuffer = toArrayBuffer(salt);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: saltBuffer, iterations: ENCRYPTION_ITERATIONS, hash: 'SHA-256' },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
};

export const encryptContentWithKey = async (data: ArrayBuffer, key: string): Promise<ArrayBuffer> => {
	const crypto = getWebCrypto();
	const salt = randomBytes(ENCRYPTION_SALT_BYTES);
	const iv = randomBytes(ENCRYPTION_IV_BYTES);
	const derived = await deriveEncryptionKey(key, salt);
	const ivBuffer = toArrayBuffer(iv);
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuffer }, derived, data);
	const encryptedBytes = new Uint8Array(encrypted);
	const tag = encryptedBytes.slice(encryptedBytes.length - ENCRYPTION_TAG_BYTES);
	const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - ENCRYPTION_TAG_BYTES);
	const payload = new Uint8Array(
		ENCRYPTION_MAGIC.length + ENCRYPTION_SALT_BYTES + ENCRYPTION_IV_BYTES + ENCRYPTION_TAG_BYTES + ciphertext.length
	);
	let offset = 0;
	payload.set(ENCRYPTION_MAGIC, offset);
	offset += ENCRYPTION_MAGIC.length;
	payload.set(salt, offset);
	offset += ENCRYPTION_SALT_BYTES;
	payload.set(iv, offset);
	offset += ENCRYPTION_IV_BYTES;
	payload.set(tag, offset);
	offset += ENCRYPTION_TAG_BYTES;
	payload.set(ciphertext, offset);
	return toArrayBuffer(payload);
};

export const decryptContentWithKey = async (data: ArrayBuffer, key: string): Promise<ArrayBuffer> => {
	const payload = new Uint8Array(data);
	const headerSize = ENCRYPTION_MAGIC.length + ENCRYPTION_SALT_BYTES + ENCRYPTION_IV_BYTES + ENCRYPTION_TAG_BYTES;
	if (payload.length <= headerSize) {
		throw new Error('Invalid encrypted payload');
	}
	const magic = payload.subarray(0, ENCRYPTION_MAGIC.length);
	if (magic.length !== ENCRYPTION_MAGIC.length || !magic.every((value, index) => value === ENCRYPTION_MAGIC[index])) {
		throw new Error('Invalid encrypted payload');
	}
	let offset = ENCRYPTION_MAGIC.length;
	const salt = payload.subarray(offset, offset + ENCRYPTION_SALT_BYTES);
	offset += ENCRYPTION_SALT_BYTES;
	const iv = payload.subarray(offset, offset + ENCRYPTION_IV_BYTES);
	offset += ENCRYPTION_IV_BYTES;
	const tag = payload.subarray(offset, offset + ENCRYPTION_TAG_BYTES);
	offset += ENCRYPTION_TAG_BYTES;
	const ciphertext = payload.subarray(offset);
	const combined = new Uint8Array(ciphertext.length + tag.length);
	combined.set(ciphertext, 0);
	combined.set(tag, ciphertext.length);
	const crypto = getWebCrypto();
	const derived = await deriveEncryptionKey(key, salt);
	const ivBuffer = toArrayBuffer(iv);
	const combinedBuffer = toArrayBuffer(combined);
	return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuffer }, derived, combinedBuffer);
};

export const encryptContent = async (data: ArrayBuffer, key: string): Promise<ArrayBuffer> => {
	if (!key) return data;
	return await encryptContentWithKey(data, key);
};

export const decryptContent = async (data: ArrayBuffer, key: string): Promise<ArrayBuffer> => {
	if (!key) return data;
	return await decryptContentWithKey(data, key);
};

export const buildEncryptionTester = async (key: string): Promise<string> => {
	const raw = textEncoder.encode(ENCRYPTION_TESTER_TEXT);
	const encrypted = await encryptContentWithKey(raw.buffer, key);
	return arrayBufferToBase64(encrypted);
};

export const verifyEncryptionTester = async (
	tester: string | undefined,
	key: string,
	mismatchMessage: string
): Promise<void> => {
	if (!tester) {
		if (key) {
			throw new Error(mismatchMessage);
		}
		return;
	}

	try {
		const decoded = base64ToArrayBuffer(tester);
		const decrypted = await decryptContentWithKey(decoded, key);
		const text = textDecoder.decode(new Uint8Array(decrypted));
		if (text !== ENCRYPTION_TESTER_TEXT) {
			throw new Error(mismatchMessage);
		}
	} catch {
		throw new Error(mismatchMessage);
	}
};

export class EncryptionService {
	private getKey: () => string;
	private getMismatchMessage: () => string;
	private isEnabled: () => boolean;

	constructor(options: {
		getKey: () => string;
		getMismatchMessage: () => string;
		isEnabled: () => boolean;
	}) {
		this.getKey = options.getKey;
		this.getMismatchMessage = options.getMismatchMessage;
		this.isEnabled = options.isEnabled;
	}

	async encryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
		return await encryptContent(data, this.getKey());
	}

	async decryptContent(data: ArrayBuffer): Promise<ArrayBuffer> {
		return await decryptContent(data, this.getKey());
	}

	async decryptContentOrThrow(data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.isEnabled()) return data;
		try {
			return await this.decryptContent(data);
		} catch (e) {
			throw new Error(this.getMismatchMessage());
		}
	}

	async buildEncryptionTester(): Promise<string> {
		return await buildEncryptionTester(this.getKey());
	}

	async verifyEncryptionTester(tester: string | undefined): Promise<void> {
		await verifyEncryptionTester(tester, this.getKey(), this.getMismatchMessage());
	}
}
