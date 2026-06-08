import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Secret-at-rest encryption for per-user LLM provider API keys.
//
// Algorithm: AES-256-GCM. The 32-byte key is derived from the
// CORE_SERVICE_ENCRYPTION_KEY environment variable:
//   - 64 hex chars  → used directly as 32 raw bytes
//   - 44 base64 chars decoding to 32 bytes → used directly
//   - anything else → treated as a passphrase and stretched via scrypt
//
// Stored blob format: base64(iv) ":" base64(authTag) ":" base64(ciphertext)

const ENV_KEY = "CORE_SERVICE_ENCRYPTION_KEY";
const SCRYPT_SALT = "octo-core-service:provider-keys";

function deriveKey(): Buffer {
	const raw = process.env[ENV_KEY];
	if (!raw || !raw.trim()) {
		throw new Error(
			`${ENV_KEY} is not set. It is required to store or read LLM provider API keys. ` +
				"Set a 32-byte key (64 hex chars / 44 base64 chars) or a passphrase.",
		);
	}
	const value = raw.trim();

	if (/^[0-9a-fA-F]{64}$/.test(value)) {
		return Buffer.from(value, "hex");
	}

	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.length === 32) return decoded;
	} catch {
		/* fall through to passphrase derivation */
	}

	// Treat as passphrase: stretch to 32 bytes with a fixed salt (deterministic
	// so the same passphrase always yields the same key across restarts).
	return scryptSync(value, SCRYPT_SALT, 32);
}

export function encryptSecret(plain: string): string {
	const key = deriveKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(blob: string): string {
	const key = deriveKey();
	const parts = blob.split(":");
	if (parts.length !== 3) {
		throw new Error("Malformed encrypted secret blob");
	}
	const [ivB64, tagB64, dataB64] = parts;
	const iv = Buffer.from(ivB64, "base64");
	const authTag = Buffer.from(tagB64, "base64");
	const ciphertext = Buffer.from(dataB64, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Used by HTTP startup checks to surface a clear error early when the env is
// missing but a key operation is attempted.
export function encryptionConfigured(): boolean {
	return Boolean(process.env[ENV_KEY] && process.env[ENV_KEY]!.trim());
}
