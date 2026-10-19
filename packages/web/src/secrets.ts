import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/** Seals and opens inbox secrets (AES-256-GCM) so they are never at rest in plaintext. */
export interface SecretBox {
  /** `v1.<iv>.<tag>.<ciphertext>` (base64url). `context` (the inbox id) is authenticated, so a value can't be moved to another row. */
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
}

/** Reads the key from `INBOX_SECRET_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). Throws if it isn't. */
export function secretBox(key: string | undefined): SecretBox {
  const raw = Buffer.from(key ?? "", "base64");
  if (raw.length !== 32) throw new Error("INBOX_SECRET_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  return {
    seal(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", raw, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
        .join(".");
    },
    open(sealed, context) {
      const [version, iv, tag, data] = sealed.split(".");
      if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
      const decipher = createDecipheriv("aes-256-gcm", raw, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
