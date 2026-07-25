import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

const KDF_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const DIGEST = "sha512";
const AAD = Buffer.from("cachette:v1");
const RECOVERY_KEY_BYTES = 20;

export type VaultKdf = {
  salt: string;
  iterations: number;
  digest: string;
  verifier: string;
};

export type EncryptedBox = {
  v: 1;
  iv: string;
  tag: string;
  data: string;
};

export function generateVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function generateRecoveryKey(): string {
  const body = randomBytes(RECOVERY_KEY_BYTES)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,4}/g)
    ?.join("-") ?? "";

  return `CV-${body}`;
}

export function normalizeRecoveryKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function createVaultKdf(masterPassword: string): Promise<{ key: Buffer; kdf: VaultKdf }> {
  const salt = randomBytes(32);
  const key = await deriveKey(masterPassword, salt.toString("base64"), KDF_ITERATIONS);

  return {
    key,
    kdf: {
      salt: salt.toString("base64"),
      iterations: KDF_ITERATIONS,
      digest: DIGEST,
      verifier: hashVerifier(key)
    }
  };
}

export function deriveKey(masterPassword: string, saltBase64: string, iterations = KDF_ITERATIONS): Promise<Buffer> {
  return pbkdf2Async(masterPassword, Buffer.from(saltBase64, "base64"), iterations, KEY_LENGTH, DIGEST);
}

export function zeroKey(key: Buffer | null | undefined): void {
  key?.fill(0);
}

export function verifyKey(key: Buffer, verifier: string): boolean {
  const actual = Buffer.from(hashVerifier(key), "hex");
  const expected = Buffer.from(verifier, "hex");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);

  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const box: EncryptedBox = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };

  return JSON.stringify(box);
}

export function decryptJson<T>(payload: string | null | undefined, key: Buffer): T | undefined {
  if (!payload) {
    return undefined;
  }

  const box = JSON.parse(payload) as EncryptedBox;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));

  const clear = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
  return JSON.parse(clear.toString("utf8")) as T;
}

function hashVerifier(key: Buffer): string {
  return createHash("sha256").update("cachette-verifier:v1").update(key).digest("hex");
}
