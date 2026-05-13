/**
 * Block M2 — Web Push delivery.
 *
 * Pure Web Crypto + Bun fetch — no `web-push` npm dependency. Implements
 * RFC 8291 (Message Encryption for Web Push) + RFC 8188 (aes128gcm
 * content encoding) + RFC 8292 (VAPID JWT).
 *
 * Public surface:
 *   - getVapidPublicKey(): base64url public key (process-stable)
 *   - subscribeUser, unsubscribeUser: persistence helpers
 *   - sendPushToUser: fan-out delivery with stale-endpoint cleanup
 *   - pushFromNotification: hook callers can fire alongside notify()
 *
 * Stale endpoints (HTTP 404/410) are deleted on next send. Other failures
 * are swallowed per-subscription. The outbound transport is replaceable
 * via `__setSendTransport` so unit tests never hit the real network.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { pushSubscriptions, users } from "../db/schema";
import type { NotificationKind } from "./notify";

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// VAPID keypair — env-first, process-cached fallback
// ---------------------------------------------------------------------------

type VapidKeypair = {
  /** Uncompressed P-256 public key, 65 bytes, base64url. */
  publicKey: string;
  /** Raw 32-byte private scalar, base64url. */
  privateKey: string;
};

let _cachedKeys: VapidKeypair | null = null;
let _warnedAboutGenerated = false;

async function generateVapidKeypair(): Promise<VapidKeypair> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const rawPub = await crypto.subtle.exportKey("raw", kp.publicKey);
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    kp.privateKey
  )) as JsonWebKey;
  if (!jwk.d) throw new Error("vapid keygen: missing private scalar");
  return {
    publicKey: b64urlEncode(rawPub),
    privateKey: jwk.d,
  };
}

export async function getVapidKeypair(): Promise<VapidKeypair> {
  if (_cachedKeys) return _cachedKeys;
  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPub && envPriv) {
    _cachedKeys = { publicKey: envPub, privateKey: envPriv };
    return _cachedKeys;
  }
  _cachedKeys = await generateVapidKeypair();
  if (!_warnedAboutGenerated) {
    _warnedAboutGenerated = true;
    console.warn(
      "[push] Using a generated VAPID keypair — subscriptions will break on " +
        "process restart. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in env to " +
        "persist across restarts. Generated public key: " +
        _cachedKeys.publicKey
    );
  }
  return _cachedKeys;
}

export async function getVapidPublicKey(): Promise<string> {
  const kp = await getVapidKeypair();
  return kp.publicKey;
}

export function __resetVapidCacheForTests(): void {
  _cachedKeys = null;
  _warnedAboutGenerated = false;
}

// ---------------------------------------------------------------------------
// Subscription persistence
// ---------------------------------------------------------------------------

export type SubscribeInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export async function subscribeUser(
  userId: string,
  sub: SubscribeInput,
  userAgent?: string
): Promise<void> {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    throw new Error("invalid subscription payload");
  }
  try {
    await db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: {
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          userAgent: userAgent ?? null,
        },
      });
  } catch (err) {
    console.error("[push] subscribeUser failed:", err);
    throw err;
  }
}

export async function unsubscribeUser(
  userId: string,
  endpoint: string
): Promise<void> {
  try {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.endpoint, endpoint)
        )
      );
  } catch (err) {
    console.error("[push] unsubscribeUser failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Web Push HTTP encryption (RFC 8291 + RFC 8188 aes128gcm)
// ---------------------------------------------------------------------------

type SubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

const TEXT = new TextEncoder();

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    "HKDF",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

export async function encryptPayload(
  payload: Uint8Array,
  recipient: { p256dh: string; auth: string }
): Promise<Uint8Array> {
  const uaPublicRaw = b64urlDecode(recipient.p256dh);
  const authSecret = b64urlDecode(recipient.auth);

  const ephemeralKp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const ephemeralPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeralKp.publicKey)
  );

  const uaPubKey = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPubKey },
      ephemeralKp.privateKey,
      256
    )
  );

  const keyInfo = concat(
    TEXT.encode("WebPush: info\0"),
    uaPublicRaw,
    ephemeralPubRaw
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    ikm,
    salt,
    TEXT.encode("Content-Encoding: aes128gcm\0"),
    16
  );
  const nonce = await hkdf(
    ikm,
    salt,
    TEXT.encode("Content-Encoding: nonce\0"),
    12
  );

  const plain = concat(payload, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      plain as BufferSource
    )
  );

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65;
  header.set(ephemeralPubRaw, 21);

  return concat(header, cipher);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// VAPID JWT (RFC 8292)
// ---------------------------------------------------------------------------

function endpointOrigin(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

export async function signVapidJwt(
  audience: string,
  subject: string
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const encHeader = b64urlEncode(TEXT.encode(JSON.stringify(header)));
  const encClaims = b64urlEncode(TEXT.encode(JSON.stringify(claims)));
  const signingInput = `${encHeader}.${encClaims}`;

  const kp = await getVapidKeypair();
  const pubRaw = b64urlDecode(kp.publicKey);
  if (pubRaw[0] !== 0x04 || pubRaw.length !== 65) {
    throw new Error("vapid public key must be 65-byte uncompressed P-256");
  }
  const x = pubRaw.slice(1, 33);
  const y = pubRaw.slice(33, 65);

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    d: kp.privateKey,
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      TEXT.encode(signingInput) as BufferSource
    )
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

export type SendTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array }
) => Promise<{ status: number }>;

let _transport: SendTransport = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body as BodyInit,
  });
  return { status: res.status };
};

export function __setSendTransport(fn: SendTransport): SendTransport {
  const prev = _transport;
  _transport = fn;
  return prev;
}

// ---------------------------------------------------------------------------
// Top-level send
// ---------------------------------------------------------------------------

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
};

function payloadJson(p: PushPayload): string {
  return JSON.stringify({
    title: p.title,
    body: p.body,
    url: p.url ?? "/",
    tag: p.tag ?? "gluecron",
    icon: p.icon ?? "/icon.svg",
  });
}

async function deliverOne(
  sub: SubscriptionRow,
  payload: PushPayload
): Promise<{ ok: boolean; status: number }> {
  try {
    const kp = await getVapidKeypair();
    const aud = endpointOrigin(sub.endpoint);
    if (!aud) return { ok: false, status: 0 };
    const sub_email =
      process.env.VAPID_SUBJECT?.trim() || "mailto:ops@gluecron.com";
    const jwt = await signVapidJwt(aud, sub_email);

    const body = await encryptPayload(TEXT.encode(payloadJson(payload)), {
      p256dh: sub.p256dh,
      auth: sub.auth,
    });

    const headers: Record<string, string> = {
      authorization: `vapid t=${jwt}, k=${kp.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
    };
    const res = await _transport(sub.endpoint, {
      method: "POST",
      headers,
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    console.error("[push] deliver failed:", err);
    return { ok: false, status: 0 };
  }
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  let rows: SubscriptionRow[] = [];
  try {
    rows = await db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  } catch (err) {
    console.error("[push] sendPushToUser select failed:", err);
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const res = await deliverOne(row, payload);
    if (res.ok) {
      sent++;
      try {
        await db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(pushSubscriptions.userId, userId),
              eq(pushSubscriptions.endpoint, row.endpoint)
            )
          );
      } catch (_) {
        // swallow
      }
    } else {
      failed++;
      if (res.status === 404 || res.status === 410) {
        try {
          await db
            .delete(pushSubscriptions)
            .where(
              and(
                eq(pushSubscriptions.userId, userId),
                eq(pushSubscriptions.endpoint, row.endpoint)
              )
            );
        } catch (_) {
          // swallow
        }
      }
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// notify() bridge
// ---------------------------------------------------------------------------

function pushPrefColumnFor(
  kind: NotificationKind
):
  | "notifyPushOnMention"
  | "notifyPushOnAssign"
  | "notifyPushOnReviewRequest"
  | "notifyPushOnDeployFailed"
  | null {
  switch (kind) {
    case "mention":
      return "notifyPushOnMention";
    case "assigned":
      return "notifyPushOnAssign";
    case "review_requested":
      return "notifyPushOnReviewRequest";
    case "deploy_failed":
      return "notifyPushOnDeployFailed";
    default:
      return null;
  }
}

/**
 * Optional hook callers can fire ALONGSIDE notify() to fan out a Web Push.
 * Looks up the user's per-event preference and silently no-ops if the user
 * opted out, the kind isn't push-eligible, or the user has no subscriptions.
 */
export async function pushFromNotification(
  userId: string,
  kind: NotificationKind,
  opts: { title: string; body?: string; url?: string }
): Promise<{ sent: number; failed: number } | null> {
  const col = pushPrefColumnFor(kind);
  if (!col) return null;
  try {
    const rows = await db
      .select({
        mention: users.notifyPushOnMention,
        assign: users.notifyPushOnAssign,
        review: users.notifyPushOnReviewRequest,
        deploy: users.notifyPushOnDeployFailed,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const u = rows[0];
    if (!u) return null;
    const allowed =
      col === "notifyPushOnMention"
        ? u.mention
        : col === "notifyPushOnAssign"
        ? u.assign
        : col === "notifyPushOnReviewRequest"
        ? u.review
        : u.deploy;
    if (!allowed) return null;
  } catch (err) {
    console.error("[push] pushFromNotification pref lookup failed:", err);
    return null;
  }
  return sendPushToUser(userId, {
    title: opts.title,
    body: opts.body ?? "",
    url: opts.url,
    tag: `${kind}:${opts.url ?? ""}`,
  });
}

export const __internal = {
  pushPrefColumnFor,
};
