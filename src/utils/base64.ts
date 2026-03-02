const BASE64_CHUNK_SIZE = 0x8000;

export class Base64Utils {
	static encode(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
			const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
			binary += String.fromCharCode(...chunk);
		}
		if (typeof btoa === 'function') {
			return btoa(binary);
		}
		if (typeof Buffer !== 'undefined') {
			return Buffer.from(bytes).toString('base64');
		}
		throw new Error('Base64 encoding not available');
	}

	static decode(base64: string): ArrayBuffer {
		if (typeof atob === 'function') {
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return bytes.buffer;
		}
		if (typeof Buffer !== 'undefined') {
			return Uint8Array.from(Buffer.from(base64, 'base64')).buffer;
		}
		throw new Error('Base64 decoding not available');
	}
}
