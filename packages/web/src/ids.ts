import { createHash, randomBytes } from "node:crypto";

export { newSecret, safeEqual, uuidv7 } from "@loopway/sources";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export const newLockToken = () => `lk_${randomBytes(18).toString("base64url")}`;
/**
 * Eight characters (40 bits) of Crockford base32, which has no I/L/O/U look-alikes, for a person to type.
 * 32 divides 256, so taking each random byte mod 32 is unbiased.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LOGIN_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const newLoginCode = () => Array.from(randomBytes(8), (b) => CROCKFORD[b % 32]).join("");
/** Accepts what people type: any case, spaces or dashes, and Crockford's O→0, I/L→1. */
export const normalizeLoginCode = (s: string) =>
  s.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
