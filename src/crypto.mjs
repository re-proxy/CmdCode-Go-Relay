import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  scryptSync,
} from "node:crypto";

const ALGO = "aes-256-gcm";

/**
 * Derives a 32-byte encryption key from the configured master key.
 * The master key is already 32 random bytes, so a plain SHA-256 is enough
 * and keeps the value stable across restarts.
 */
export function deriveKey(masterKeyB64) {
  return createHash("sha256").update(Buffer.from(masterKeyB64, "base64")).digest();
}

export function encryptString(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

export function decryptString(key, payload) {
  if (typeof payload !== "string") return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ct = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Constant-time comparison of two strings. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison to avoid length-only timing signals.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : randomBytes(16);
  const derived = scryptSync(password, salt, 32);
  return { salt: salt.toString("hex"), hash: derived.toString("hex") };
}

export function verifyPassword(password, saltHex, hashHex) {
  try {
    const { hash } = hashPassword(password, saltHex);
    return safeEqual(hash, hashHex);
  } catch {
    return false;
  }
}
