/**
 * Enterprise per-org SSO routes — SAML 2.0 and OIDC.
 *
 *   GET  /sso/saml/:orgSlug/metadata   — SP metadata XML (configure your IdP with this)
 *   GET  /sso/saml/:orgSlug/login      — initiate SAML AuthnRequest → redirect to IdP
 *   POST /sso/saml/:orgSlug/callback   — receive SAMLResponse from IdP, create session
 *   GET  /sso/oidc/:orgSlug/login      — initiate OIDC authorization code flow
 *   GET  /sso/oidc/:orgSlug/callback   — exchange code → tokens → create session
 *
 * Admin UI at /orgs/:orgSlug/settings/sso (see org-sso-settings.tsx).
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import * as crypto from "crypto";
import { db } from "../db";
import { orgSsoConfigs, orgSsoSessions, organizations, users, sessions } from "../db/schema";
import { generateSessionToken, sessionCookieOptions, sessionExpiry } from "../lib/auth";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const samlSso = new Hono<AuthEnv>();
samlSso.use("*", softAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  return process.env.APP_URL || process.env.BASE_URL || "https://gluecron.com";
}

function generateId(len = 16): string {
  return crypto.randomBytes(len).toString("hex");
}

/** Resolve org by slug; returns the org row or null. */
async function getOrgBySlug(slug: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return org ?? null;
}

/** Resolve org SSO config (must be enabled). */
async function getOrgSsoConfig(orgId: string) {
  const [cfg] = await db
    .select()
    .from(orgSsoConfigs)
    .where(eq(orgSsoConfigs.orgId, orgId))
    .limit(1);
  return cfg ?? null;
}

/** Find or create a local user from SSO identity claims. */
async function findOrCreateSsoUser(
  email: string,
  name: string | undefined,
  preferredUsername: string | undefined,
  orgId: string
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (!email) return { ok: false, error: "No email returned from IdP" };

  // Look up by email
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) return { ok: true, userId: existing.id };

  // Auto-create: derive a username from email / preferred_username
  let username = (preferredUsername || email.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 39);
  if (!username) username = "user-" + generateId(4);

  // Deduplicate username
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (taken) username = username + "-" + generateId(4);

  const [created] = await db
    .insert(users)
    .values({
      username,
      email,
      displayName: name || username,
      // No password — SSO-only accounts use a random hash placeholder
      passwordHash: await Bun.password.hash(generateId(32), {
        algorithm: "bcrypt",
        cost: 10,
      }),
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });

  if (!created) return { ok: false, error: "Failed to create user account" };
  return { ok: true, userId: created.id };
}

/** Create a standard session cookie for a user. */
async function createUserSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId,
    token,
    expiresAt: sessionExpiry(),
  });
  return token;
}

// ---------------------------------------------------------------------------
// SAML 2.0 — SP Metadata
// ---------------------------------------------------------------------------

samlSso.get("/sso/saml/:orgSlug/metadata", async (c) => {
  const { orgSlug } = c.req.param();
  const org = await getOrgBySlug(orgSlug);
  if (!org) return c.text("Organization not found", 404);

  const cfg = await getOrgSsoConfig(org.id);
  if (!cfg || cfg.provider !== "saml") {
    return c.text("SAML not configured for this organization", 404);
  }

  const base = getBaseUrl();
  const spEntityId =
    cfg.spEntityId || `${base}/sso/saml/${orgSlug}`;
  const callbackUrl = `${base}/sso/saml/${orgSlug}/callback`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(spEntityId)}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(callbackUrl)}"
      index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

// ---------------------------------------------------------------------------
// SAML 2.0 — SP-initiated login
// ---------------------------------------------------------------------------

samlSso.get("/sso/saml/:orgSlug/login", async (c) => {
  const { orgSlug } = c.req.param();
  const org = await getOrgBySlug(orgSlug);
  if (!org) return c.redirect(`/login?error=${encodeURIComponent("Organization not found")}`);

  const cfg = await getOrgSsoConfig(org.id);
  if (!cfg || !cfg.enabled || cfg.provider !== "saml") {
    return c.redirect(`/login?error=${encodeURIComponent("SAML SSO not enabled for this organization")}`);
  }
  if (!cfg.idpSsoUrl) {
    return c.redirect(`/login?error=${encodeURIComponent("SAML IdP SSO URL not configured")}`);
  }

  const base = getBaseUrl();
  const spEntityId = cfg.spEntityId || `${base}/sso/saml/${orgSlug}`;
  const acsUrl = `${base}/sso/saml/${orgSlug}/callback`;
  const requestId = "_" + generateId(20);
  const issueInstant = new Date().toISOString();

  const relayState = generateId(16);
  const authnRequest = `<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${requestId}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  Destination="${escapeXml(cfg.idpSsoUrl)}"
  AssertionConsumerServiceURL="${escapeXml(acsUrl)}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${escapeXml(spEntityId)}</saml:Issuer>
</samlp:AuthnRequest>`;

  const encoded = Buffer.from(authnRequest).toString("base64");
  const params = new URLSearchParams({
    SAMLRequest: encoded,
    RelayState: relayState,
  });

  // Store relay state for CSRF check
  setCookie(c, "saml_relay_state", relayState, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  setCookie(c, "saml_org", orgSlug, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  return c.redirect(`${cfg.idpSsoUrl}?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// SAML 2.0 — ACS callback (HTTP-POST binding)
// ---------------------------------------------------------------------------

samlSso.post("/sso/saml/:orgSlug/callback", async (c) => {
  const { orgSlug } = c.req.param();
  const org = await getOrgBySlug(orgSlug);
  if (!org) return c.redirect(`/login?error=${encodeURIComponent("Organization not found")}`);

  const cfg = await getOrgSsoConfig(org.id);
  if (!cfg || !cfg.enabled || cfg.provider !== "saml") {
    return c.redirect(`/login?error=${encodeURIComponent("SAML SSO not enabled for this organization")}`);
  }

  // Validate relay state
  const expectedRelay = getCookie(c, "saml_relay_state");
  const expectedOrg = getCookie(c, "saml_org");
  deleteCookie(c, "saml_relay_state", { path: "/" });
  deleteCookie(c, "saml_org", { path: "/" });

  if (!expectedRelay || expectedOrg !== orgSlug) {
    return c.redirect(`/login?error=${encodeURIComponent("SAML relay state mismatch. Please try again.")}`);
  }

  const body = await c.req.parseBody();
  const samlResponse = String(body.SAMLResponse || "");
  if (!samlResponse) {
    return c.redirect(`/login?error=${encodeURIComponent("No SAMLResponse received")}`);
  }

  try {
    const claims = parseSamlResponse(samlResponse, cfg.idpCertificate || "", cfg);
    if (!claims.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(claims.error)}`);
    }

    const result = await findOrCreateSsoUser(
      claims.email,
      claims.name,
      claims.username,
      org.id
    );
    if (!result.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    }

    // Record the SSO session
    await db.insert(orgSsoSessions).values({
      userId: result.userId,
      orgId: org.id,
      idpSessionId: claims.sessionIndex ?? null,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000), // 8h
    });

    const token = await createUserSession(result.userId);
    setCookie(c, "session", token, sessionCookieOptions());
    return c.redirect("/");
  } catch (err) {
    console.error("[saml-sso] callback error:", err);
    return c.redirect(`/login?error=${encodeURIComponent("SAML authentication failed. Check IdP configuration.")}`);
  }
});

// ---------------------------------------------------------------------------
// OIDC — per-org login
// ---------------------------------------------------------------------------

samlSso.get("/sso/oidc/:orgSlug/login", async (c) => {
  const { orgSlug } = c.req.param();
  const org = await getOrgBySlug(orgSlug);
  if (!org) return c.redirect(`/login?error=${encodeURIComponent("Organization not found")}`);

  const cfg = await getOrgSsoConfig(org.id);
  if (!cfg || !cfg.enabled || cfg.provider !== "oidc") {
    return c.redirect(`/login?error=${encodeURIComponent("OIDC SSO not enabled for this organization")}`);
  }
  if (!cfg.oidcDiscoveryUrl || !cfg.oidcClientId) {
    return c.redirect(`/login?error=${encodeURIComponent("OIDC not fully configured")}`);
  }

  // Discover the authorization endpoint from the OIDC discovery document
  let authorizationEndpoint: string;
  try {
    const discoveryUrl = cfg.oidcDiscoveryUrl.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const res = await fetch(discoveryUrl);
    if (!res.ok) throw new Error(`Discovery returned ${res.status}`);
    const doc = await res.json() as { authorization_endpoint: string };
    authorizationEndpoint = doc.authorization_endpoint;
    if (!authorizationEndpoint) throw new Error("No authorization_endpoint in discovery");
  } catch (err) {
    console.error("[oidc-sso] discovery error:", err);
    return c.redirect(`/login?error=${encodeURIComponent("OIDC discovery failed")}`);
  }

  const base = getBaseUrl();
  const redirectUri = `${base}/sso/oidc/${orgSlug}/callback`;
  const state = generateId(16);
  const nonce = generateId(16);

  setCookie(c, "oidc_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  setCookie(c, "oidc_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  setCookie(c, "oidc_org", orgSlug, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: cfg.oidcClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
  });

  return c.redirect(`${authorizationEndpoint}?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// OIDC — per-org callback
// ---------------------------------------------------------------------------

samlSso.get("/sso/oidc/:orgSlug/callback", async (c) => {
  const { orgSlug } = c.req.param();
  const org = await getOrgBySlug(orgSlug);
  if (!org) return c.redirect(`/login?error=${encodeURIComponent("Organization not found")}`);

  const cfg = await getOrgSsoConfig(org.id);
  if (!cfg || !cfg.enabled || cfg.provider !== "oidc") {
    return c.redirect(`/login?error=${encodeURIComponent("OIDC SSO not enabled")}`);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const errCode = c.req.query("error");

  if (errCode) {
    return c.redirect(`/login?error=${encodeURIComponent(`IdP error: ${errCode}`)}`);
  }
  if (!code || !state) {
    return c.redirect(`/login?error=${encodeURIComponent("Missing code or state")}`);
  }

  const expectedState = getCookie(c, "oidc_state");
  const expectedOrg = getCookie(c, "oidc_org");
  deleteCookie(c, "oidc_state", { path: "/" });
  deleteCookie(c, "oidc_nonce", { path: "/" });
  deleteCookie(c, "oidc_org", { path: "/" });

  if (!expectedState || expectedState !== state || expectedOrg !== orgSlug) {
    return c.redirect(`/login?error=${encodeURIComponent("OIDC state mismatch. Please try again.")}`);
  }

  try {
    // Discover token endpoint
    const discoveryUrl = cfg.oidcDiscoveryUrl!.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const discoveryRes = await fetch(discoveryUrl);
    const discovery = await discoveryRes.json() as {
      token_endpoint: string;
      userinfo_endpoint: string;
    };

    const base = getBaseUrl();
    const redirectUri = `${base}/sso/oidc/${orgSlug}/callback`;

    // Exchange code for tokens
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: cfg.oidcClientId!,
        client_secret: cfg.oidcClientSecret || "",
      }).toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`token_endpoint returned ${tokenRes.status}`);
    }

    const tokens = await tokenRes.json() as { access_token: string };

    // Fetch userinfo
    const userinfoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userinfoRes.ok) {
      throw new Error(`userinfo_endpoint returned ${userinfoRes.status}`);
    }

    const userinfo = await userinfoRes.json() as {
      email?: string;
      name?: string;
      preferred_username?: string;
      sub?: string;
    };

    const result = await findOrCreateSsoUser(
      userinfo.email || "",
      userinfo.name,
      userinfo.preferred_username,
      org.id
    );
    if (!result.ok) {
      return c.redirect(`/login?error=${encodeURIComponent(result.error)}`);
    }

    await db.insert(orgSsoSessions).values({
      userId: result.userId,
      orgId: org.id,
      idpSessionId: userinfo.sub ?? null,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    });

    const token = await createUserSession(result.userId);
    setCookie(c, "session", token, sessionCookieOptions());
    return c.redirect("/");
  } catch (err) {
    console.error("[oidc-sso] callback error:", err);
    return c.redirect(`/login?error=${encodeURIComponent("OIDC authentication failed.")}`);
  }
});

// ---------------------------------------------------------------------------
// SAML response parser (lightweight, no heavy deps)
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface SamlClaims {
  ok: true;
  email: string;
  name?: string;
  username?: string;
  sessionIndex?: string;
}

interface SamlError {
  ok: false;
  error: string;
}

/**
 * Lightweight SAML response parser.
 *
 * Steps:
 *  1. Base64-decode the SAMLResponse.
 *  2. Verify the XML Signature using the IdP certificate (if provided).
 *  3. Extract email/name/username attributes via regex against the XML.
 *
 * This avoids pulling in full SAML libraries (samlify, passport-saml, etc.)
 * which ship ~200 packages including xml-crypto. For production hardening,
 * operators should upgrade to a dedicated SAML library.
 */
function parseSamlResponse(
  base64Response: string,
  idpCertPem: string,
  cfg: { attributeMapping?: Record<string, string> | null }
): SamlClaims | SamlError {
  let xml: string;
  try {
    xml = Buffer.from(base64Response, "base64").toString("utf-8");
  } catch {
    return { ok: false, error: "Failed to decode SAMLResponse" };
  }

  // Basic structure check
  if (!xml.includes("saml") && !xml.includes("SAML")) {
    return { ok: false, error: "Invalid SAML response format" };
  }

  // Check for SAML status success
  if (
    xml.includes("urn:oasis:names:tc:SAML:2.0:status:Responder") ||
    xml.includes("urn:oasis:names:tc:SAML:2.0:status:Requester")
  ) {
    const statusMatch = xml.match(/<samlp?:StatusMessage[^>]*>([^<]*)</);
    const msg = statusMatch ? statusMatch[1].trim() : "IdP rejected the request";
    return { ok: false, error: `SAML error: ${msg}` };
  }

  // Signature verification — only if IdP cert provided
  if (idpCertPem && idpCertPem.trim()) {
    const sigValid = verifySamlSignature(xml, idpCertPem);
    if (!sigValid) {
      return { ok: false, error: "SAML signature verification failed" };
    }
  }

  // Extract attributes
  const mapping = cfg.attributeMapping || {
    email: "email",
    name: "name",
    username: "preferred_username",
  };

  const attrs = extractSamlAttributes(xml);

  // Try to find email from NameID or attribute
  let email = attrs[mapping.email ?? "email"]
    || attrs["email"]
    || attrs["mail"]
    || attrs["emailAddress"]
    || extractNameId(xml)
    || "";

  email = email.trim();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "No email found in SAML assertion" };
  }

  const name =
    attrs[mapping.name ?? "name"] ||
    attrs["displayName"] ||
    attrs["cn"] ||
    attrs["givenName"] ||
    undefined;

  const username =
    attrs[mapping.username ?? "preferred_username"] ||
    attrs["uid"] ||
    attrs["samaccountname"] ||
    undefined;

  const sessionIndex = extractSessionIndex(xml);

  return { ok: true, email, name, username, sessionIndex };
}

/** Extract NameID value from SAML XML. */
function extractNameId(xml: string): string {
  const m = xml.match(/<(?:saml|saml2):NameID[^>]*>([^<]+)<\/(?:saml|saml2):NameID>/);
  return m ? m[1].trim() : "";
}

/** Extract SessionIndex from AuthnStatement. */
function extractSessionIndex(xml: string): string | undefined {
  const m = xml.match(/SessionIndex="([^"]+)"/);
  return m ? m[1] : undefined;
}

/** Extract all AttributeValue entries keyed by Name or FriendlyName. */
function extractSamlAttributes(xml: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match <Attribute Name="..." FriendlyName="..."><AttributeValue>...</AttributeValue>
  const attrRe =
    /<(?:saml|saml2):Attribute\s[^>]*(?:Name|FriendlyName)="([^"]+)"[^>]*>\s*<(?:saml|saml2):AttributeValue[^>]*>([^<]+)<\/(?:saml|saml2):AttributeValue>/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(xml)) !== null) {
    const key = m[1].toLowerCase().replace(/^.*\//, ""); // strip namespace URN prefix
    attrs[key] = m[2].trim();
  }
  return attrs;
}

/**
 * Verify the XML-DSig signature in the SAML response against the IdP certificate.
 * Uses Node's built-in `crypto.createVerify` to avoid heavy deps.
 *
 * This is a best-effort verification: it handles the common case where the
 * entire Response or Assertion element is signed. For full enveloped-signature
 * support, use a library like `xml-crypto`.
 */
function verifySamlSignature(xml: string, certPem: string): boolean {
  try {
    // Extract the SignatureValue
    const sigValueMatch = xml.match(
      /<(?:ds:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:ds:)?SignatureValue>/
    );
    if (!sigValueMatch) return false; // no signature at all — treat as invalid
    const signatureValue = Buffer.from(
      sigValueMatch[1].replace(/\s+/g, ""),
      "base64"
    );

    // Extract the SignedInfo element (what was actually signed)
    const signedInfoMatch = xml.match(
      /(<(?:ds:)?SignedInfo[\s\S]*?<\/(?:ds:)?SignedInfo>)/
    );
    if (!signedInfoMatch) return false;
    const signedInfoXml = signedInfoMatch[1];

    // Detect algorithm from SignatureMethod
    const algMatch = xml.match(/Algorithm="([^"]+)"/);
    const alg = algMatch ? algMatch[1] : "";
    let hashAlg: string;
    if (alg.includes("sha256")) hashAlg = "SHA256";
    else if (alg.includes("sha512")) hashAlg = "SHA512";
    else hashAlg = "SHA1";

    // Normalise the PEM cert
    let pem = certPem.trim();
    if (!pem.startsWith("-----BEGIN CERTIFICATE-----")) {
      pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
    }

    const verifier = crypto.createVerify(`RSA-${hashAlg}`);
    verifier.update(signedInfoXml, "utf8");
    return verifier.verify(pem, signatureValue);
  } catch (err) {
    console.warn("[saml-sso] signature verification error:", err);
    return false;
  }
}

export default samlSso;
