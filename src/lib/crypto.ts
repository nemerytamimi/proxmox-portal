import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

import { env } from "./env";

/**
 * Guest root passwords have to survive in the database long enough for
 * Terraform to hand them to Proxmox on every apply, so they cannot be hashed.
 * They are encrypted with AES-256-GCM under a key separate from AUTH_SECRET and
 * are never rendered back into any page — only decrypted inside the worker.
 */

const KEY_LEN = 32;
const IV_LEN = 12;
const SALT = "proxmox-portal.rootpw.v1";

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(env.encryptionKey, SALT, KEY_LEN);
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(blob: string): string {
  const [version, ivB64, tagB64, dataB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
