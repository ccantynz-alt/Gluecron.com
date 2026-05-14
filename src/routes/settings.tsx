/**
 * User settings routes — profile, SSH keys.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, sshKeys } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { raw } from "hono/html";
import { composeDigest } from "../lib/email-digest";
import {
  composeSleepModeReport,
  renderSleepModeDigest,
} from "../lib/sleep-mode";
import {
  scheduleAccountDeletion,
  cancelAccountDeletion,
  daysUntilPurge,
} from "../lib/account-deletion";
import { deleteCookie } from "hono/cookie";
import {
  Alert,
  Button,
  Flex,
  Form,
  FormGroup,
  Input,
  PageHeader,
  Section,
  Text,
  TextArea,
} from "../views/ui";

const settings = new Hono<AuthEnv>();

// Auth guard scoped to /settings paths only
settings.use("/settings/*", requireAuth);
settings.use("/settings", requireAuth);
settings.use("/api/user/*", requireAuth);

// Profile settings
settings.get("/settings", (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  return c.html(
    <Layout title="Settings" user={user}>
      <div class="settings-container">
        <PageHeader title="Profile settings" />
        {success && (
          <Alert variant="success">
            {decodeURIComponent(success)}
          </Alert>
        )}
        <Form method="post" action="/settings/profile">
          <FormGroup label="Username" htmlFor="username">
            <Input
              name="username"
              id="username"
              type="text"
              value={user.username}
              disabled
            />
          </FormGroup>
          <FormGroup label="Display name" htmlFor="display_name">
            <Input
              name="display_name"
              id="display_name"
              value={user.displayName || ""}
              placeholder="Your display name"
            />
          </FormGroup>
          <FormGroup label="Bio" htmlFor="bio">
            <TextArea
              name="bio"
              id="bio"
              rows={3}
              placeholder="Tell us about yourself"
              value={user.bio || ""}
            />
          </FormGroup>
          <FormGroup label="Email" htmlFor="email">
            <Input
              name="email"
              id="email"
              type="email"
              value={user.email}
              required
            />
          </FormGroup>
          <Button type="submit" variant="primary">
            Update profile
          </Button>
        </Form>

        <h3 style="margin-top: 32px; font-size: 16px">Email notifications</h3>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px">
          Opt out of individual email categories. In-app notifications are
          unaffected and continue to appear in your inbox.
        </p>
        <form method="post" action="/settings/notifications">
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_mention"
              value="1"
              checked={user.notifyEmailOnMention}
              aria-label="Someone @mentions me or requests a review"
            />
            <span>
              Someone <code>@mentions</code> me or requests a review
            </span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_assign"
              value="1"
              checked={user.notifyEmailOnAssign}
              aria-label="I am assigned to an issue or PR"
            />
            <span>I am assigned to an issue or PR</span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_on_gate_fail"
              value="1"
              checked={user.notifyEmailOnGateFail}
              aria-label="A gate fails on one of my repositories"
            />
            <span>A gate fails on one of my repositories</span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_email_digest_weekly"
              value="1"
              checked={user.notifyEmailDigestWeekly}
              aria-label="Weekly digest email"
            />
            <span>
              Weekly digest &mdash;{" "}
              <a href="/settings/digest/preview">preview</a>
            </span>
          </label>
          <h3 style="margin-top: 32px; font-size: 16px">Sleep Mode</h3>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px">
            Toggle Sleep Mode. Walk away. Wake up to a daily digest of what
            Claude shipped overnight &mdash; PRs auto-merged, issues built
            from <code>ai:build</code> labels, AI reviews, security
            auto-fixes, gate auto-repairs.{" "}
            <a href="/sleep-mode">Learn more</a>.
          </p>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="sleep_mode_enabled"
              value="1"
              checked={user.sleepModeEnabled}
              aria-label="Enable Sleep Mode"
            />
            <span>Enable Sleep Mode (daily &ldquo;overnight&rdquo; digest)</span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); font-size: 14px"
          >
            <span>Send my morning digest at (UTC hour, 0-23):</span>
            <input
              type="number"
              name="sleep_mode_digest_hour_utc"
              min={0}
              max={23}
              step={1}
              value={String(user.sleepModeDigestHourUtc)}
              style="width:72px"
              aria-label="Sleep Mode digest UTC hour"
            />
            <a href="/settings/sleep-mode/preview">Preview digest now</a>
          </label>
          <h3 style="margin-top: 32px; font-size: 16px">Mobile push notifications</h3>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px">
            Install Gluecron as a PWA (look for the install banner at the
            bottom of the page after a few visits) to get push notifications
            when something needs your attention. Per-event filters below
            control which notification kinds trigger a push.
          </p>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_push_on_mention"
              value="1"
              checked={user.notifyPushOnMention}
              aria-label="Someone @mentions me"
            />
            <span>
              Someone <code>@mentions</code> me
            </span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_push_on_assign"
              value="1"
              checked={user.notifyPushOnAssign}
              aria-label="I am assigned to an issue or PR"
            />
            <span>I am assigned to an issue or PR</span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_push_on_review_request"
              value="1"
              checked={user.notifyPushOnReviewRequest}
              aria-label="Someone requests a review from me"
            />
            <span>Someone requests a review from me</span>
          </label>
          <label
            style="display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); font-size: 14px"
          >
            <input
              type="checkbox"
              name="notify_push_on_deploy_failed"
              value="1"
              checked={user.notifyPushOnDeployFailed}
              aria-label="A deploy fails"
            />
            <span>A deploy fails on one of my repositories</span>
          </label>
          <button type="submit" class="btn btn-primary">
            Save preferences
          </button>
        </form>
        <div
          id="gc-push-device"
          style="margin-top:var(--space-4);padding:var(--space-3);border:1px solid var(--border);border-radius:6px;background:var(--bg-elevated,transparent)"
        >
          <div
            id="gc-push-status"
            style="font-size:13px;color:var(--text-muted)"
          >
            Push status: checking…
          </div>
          <div style="margin-top:var(--space-2);display:flex;gap:var(--space-2);flex-wrap:wrap">
            <button type="button" id="gc-push-subscribe" class="btn btn-sm btn-primary">
              Subscribe on this device
            </button>
            <button type="button" id="gc-push-unsubscribe" class="btn btn-sm">
              Unsubscribe
            </button>
            <button type="button" id="gc-push-test" class="btn btn-sm">
              Send test notification
            </button>
          </div>
          <div
            id="gc-push-msg"
            role="status"
            style="margin-top:8px;font-size:12px;color:var(--text-muted);min-height:1em"
          />
        </div>
        <script dangerouslySetInnerHTML={{ __html: pushDeviceScript }} />
        {renderDeleteAccountSection({ user, csrfToken: c.get("csrfToken") })}
      </div>
    </Layout>
  );
});

/** Block P5 — Danger zone at bottom of /settings. */
function renderDeleteAccountSection(args: {
  user: { id: string; username: string; deletedAt: Date | null; deletionScheduledFor: Date | null };
  csrfToken: string | undefined;
}) {
  const { user, csrfToken } = args;
  const scheduled = user.deletedAt !== null;
  const daysLeft = daysUntilPurge({ deletionScheduledFor: user.deletionScheduledFor });
  const dangerStyle =
    "margin-top:48px;padding:20px;border:1px solid #e5484d;border-radius:8px;background:rgba(229,72,77,0.04)";

  if (scheduled) {
    return (
      <div style={dangerStyle}>
        <h3 style="margin:0 0 8px 0;font-size:16px;color:#e5484d">
          Account scheduled for deletion
        </h3>
        <p style="margin:0 0 12px 0;font-size:14px">
          Your account is scheduled for permanent deletion in{" "}
          <strong>{daysLeft ?? 0}</strong>{" "}
          {daysLeft === 1 ? "day" : "days"}. Cancel below to keep your
          account; signing in again also cancels the deletion automatically.
        </p>
        <form method="post" action="/settings/delete-account/cancel">
          <input type="hidden" name="_csrf" value={csrfToken || ""} />
          <button type="submit" class="btn btn-primary">
            Cancel deletion
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={dangerStyle}>
      <h3 style="margin:0 0 8px 0;font-size:16px;color:#e5484d">
        Delete account
      </h3>
      <p style="margin:0 0 8px 0;font-size:14px">
        Deleting your account starts a 30-day grace period. Your repos,
        issues, PRs, and settings are kept during that window — sign in
        any time before it ends to cancel. After 30 days everything is
        permanently purged.
      </p>
      <p style="margin:0 0 12px 0;font-size:13px;color:var(--text-muted)">
        To confirm, type your username (<code>{user.username}</code>) below.
      </p>
      <form method="post" action="/settings/delete-account">
        <input type="hidden" name="_csrf" value={csrfToken || ""} />
        <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
          <input
            type="text"
            name="confirm_username"
            required
            autocomplete="off"
            placeholder={user.username}
            aria-label="Type your username to confirm account deletion"
            style="font-family:var(--font-mono);font-size:13px;padding:6px 8px;min-width:220px"
          />
          <button type="submit" class="btn btn-danger">
            Delete my account
          </button>
        </div>
      </form>
    </div>
  );
}

// Block P5 — schedule a deletion.
settings.post("/settings/delete-account", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const confirm = String(body.confirm_username || "").trim();
  if (confirm !== user.username) {
    return c.text(
      "Username confirmation did not match. Account NOT deleted.",
      400
    );
  }
  const result = await scheduleAccountDeletion(user.id);
  if (!result.ok) {
    return c.text("Failed to schedule deletion. Please try again later.", 500);
  }
  deleteCookie(c, "session", { path: "/" });
  return c.redirect("/login?info=Account+scheduled+for+deletion");
});

// Block P5 — cancel a pending deletion.
settings.post("/settings/delete-account/cancel", async (c) => {
  const user = c.get("user")!;
  await cancelAccountDeletion(user.id);
  return c.redirect("/settings?success=Account+deletion+cancelled");
});

// Preview the Sleep Mode digest in-browser (rendered HTML).
settings.get("/settings/sleep-mode/preview", async (c) => {
  const user = c.get("user")!;
  const report = await composeSleepModeReport(user.id);
  const rendered = renderSleepModeDigest(report, { username: user.username });
  const total =
    report.prsAutoMerged.length +
    report.issuesBuiltByAi.length +
    report.aiReviewsPosted +
    report.securityIssuesAutoFixed +
    report.gateFailuresAutoRepaired;
  return c.html(
    <Layout title="Sleep Mode preview" user={user}>
      <h2>Sleep Mode preview</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Subject: <code>{rendered.subject}</code>
      </p>
      <p style="font-size:12px;color:var(--text-muted)">
        Window: {report.windowHours}h &middot; PRs auto-merged:{" "}
        {report.prsAutoMerged.length} &middot; Issues built:{" "}
        {report.issuesBuiltByAi.length} &middot; AI reviews:{" "}
        {report.aiReviewsPosted} &middot; Security auto-fixed:{" "}
        {report.securityIssuesAutoFixed} &middot; Gates repaired:{" "}
        {report.gateFailuresAutoRepaired} &middot; Hours saved:{" "}
        {report.hoursSaved} &middot; Total events: {total}
      </p>
      <div class="panel" style="padding:var(--space-5);background:#fff;color:#111">
        {raw(rendered.html)}
      </div>
      <p style="margin-top:20px">
        <a href="/settings">Back to settings</a>
      </p>
    </Layout>
  );
});

// Preview the weekly digest in-browser (rendered HTML)
settings.get("/settings/digest/preview", async (c) => {
  const user = c.get("user")!;
  const body = await composeDigest(user.id);
  if (!body) {
    return c.html(
      <Layout title="Digest preview" user={user}>
        <h2>Digest preview</h2>
        <p>Could not compose a digest right now.</p>
        <p>
          <a href="/settings">Back to settings</a>
        </p>
      </Layout>
    );
  }
  return c.html(
    <Layout title="Digest preview" user={user}>
      <h2>Digest preview</h2>
      <p style="color:var(--text-muted);font-size:13px">
        Subject: <code>{body.subject}</code>
      </p>
      <p style="font-size:12px;color:var(--text-muted)">
        Notifications: {body.counts.notifications} · Failed gates:{" "}
        {body.counts.failedGates} · Repaired: {body.counts.repairedGates} ·
        Merged PRs: {body.counts.mergedPrs}
      </p>
      <div
        class="panel"
        style="padding:var(--space-5);background:#fff;color:#111"
      >
        {raw(body.html)}
      </div>
      <p style="margin-top:20px">
        <a href="/settings">Back to settings</a>
      </p>
    </Layout>
  );
});

settings.post("/settings/notifications", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  // Coerce the Sleep Mode hour to a clamped integer 0-23.
  const rawHour = String(body.sleep_mode_digest_hour_utc ?? "");
  let hour = Number.parseInt(rawHour, 10);
  if (!Number.isFinite(hour)) hour = user.sleepModeDigestHourUtc;
  if (hour < 0) hour = 0;
  if (hour > 23) hour = 23;
  await db
    .update(users)
    .set({
      notifyEmailOnMention: String(body.notify_email_on_mention || "") === "1",
      notifyEmailOnAssign: String(body.notify_email_on_assign || "") === "1",
      notifyEmailOnGateFail:
        String(body.notify_email_on_gate_fail || "") === "1",
      notifyEmailDigestWeekly:
        String(body.notify_email_digest_weekly || "") === "1",
      sleepModeEnabled: String(body.sleep_mode_enabled || "") === "1",
      sleepModeDigestHourUtc: hour,
      // Block M2 — per-event push preferences.
      notifyPushOnMention:
        String(body.notify_push_on_mention || "") === "1",
      notifyPushOnAssign:
        String(body.notify_push_on_assign || "") === "1",
      notifyPushOnReviewRequest:
        String(body.notify_push_on_review_request || "") === "1",
      notifyPushOnDeployFailed:
        String(body.notify_push_on_deploy_failed || "") === "1",
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));
  return c.redirect("/settings?success=Notification+preferences+updated");
});

// Block M2 — client-side device subscribe/unsubscribe/test helpers. Plain
// JS, no framework; reads/writes via the /pwa/* endpoints.
const pushDeviceScript = `
(function(){
  var statusEl = document.getElementById('gc-push-status');
  var msgEl    = document.getElementById('gc-push-msg');
  var subBtn   = document.getElementById('gc-push-subscribe');
  var unsubBtn = document.getElementById('gc-push-unsubscribe');
  var testBtn  = document.getElementById('gc-push-test');
  function setStatus(s){ if (statusEl) statusEl.textContent = 'Push status: ' + s; }
  function setMsg(s){ if (msgEl) msgEl.textContent = s; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus("Browser doesn't support push");
    if (subBtn) subBtn.disabled = true;
    if (unsubBtn) unsubBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
    return;
  }
  function b64uToU8(s){
    var pad = '='.repeat((4 - s.length % 4) % 4);
    var b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i=0; i<bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function getReg(){
    return navigator.serviceWorker.getRegistration('/').then(function(r){
      return r || navigator.serviceWorker.register('/sw-push.js', { scope: '/' });
    });
  }
  function refresh(){
    getReg().then(function(reg){
      return reg.pushManager.getSubscription();
    }).then(function(sub){
      if (sub) {
        setStatus('Enabled on this device');
        if (subBtn) subBtn.disabled = true;
        if (unsubBtn) unsubBtn.disabled = false;
        if (testBtn) testBtn.disabled = false;
      } else {
        setStatus('Not subscribed on this device');
        if (subBtn) subBtn.disabled = false;
        if (unsubBtn) unsubBtn.disabled = true;
        if (testBtn) testBtn.disabled = true;
      }
    }).catch(function(){ setStatus('unavailable'); });
  }
  if (subBtn) subBtn.addEventListener('click', function(){
    setMsg('Requesting permission…');
    Notification.requestPermission().then(function(perm){
      if (perm !== 'granted') { setMsg('Permission denied.'); return; }
      return fetch('/pwa/vapid-public-key').then(function(r){ return r.json(); }).then(function(j){
        if (!j || !j.key) throw new Error('no vapid key');
        return getReg().then(function(reg){
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64uToU8(j.key),
          });
        });
      }).then(function(sub){
        var json = sub.toJSON();
        return fetch('/pwa/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        });
      }).then(function(){ setMsg('Subscribed.'); refresh(); });
    }).catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  if (unsubBtn) unsubBtn.addEventListener('click', function(){
    getReg().then(function(reg){
      return reg.pushManager.getSubscription();
    }).then(function(sub){
      if (!sub) return;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function(){
        return fetch('/pwa/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      });
    }).then(function(){ setMsg('Unsubscribed.'); refresh(); })
      .catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  if (testBtn) testBtn.addEventListener('click', function(){
    fetch('/pwa/test', { method: 'POST' }).then(function(r){ return r.json(); })
      .then(function(j){
        setMsg('Sent ' + (j.sent || 0) + ', failed ' + (j.failed || 0) + '.');
      }).catch(function(err){ setMsg('Failed: ' + (err && err.message || err)); });
  });
  refresh();
})();
`;

settings.post("/settings/profile", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  await db
    .update(users)
    .set({
      displayName: String(body.display_name || "").trim() || null,
      bio: String(body.bio || "").trim() || null,
      email: String(body.email || "").trim() || user.email,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.redirect("/settings?success=Profile+updated");
});

// SSH Keys page
settings.get("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));

  return c.html(
    <Layout title="SSH Keys" user={user}>
      <div class="settings-container">
        <PageHeader title="SSH Keys" />
        {success && (
          <Alert variant="success">{decodeURIComponent(success)}</Alert>
        )}
        {error && (
          <Alert variant="error">{decodeURIComponent(error)}</Alert>
        )}
        <div class="ssh-keys-list">
          {keys.length === 0 ? (
            <Text muted>
              No SSH keys yet. Add one below.
            </Text>
          ) : (
            keys.map((key) => (
              <div class="ssh-key-item">
                <div>
                  <strong>{key.title}</strong>
                  <div class="ssh-key-meta">
                    <code>{key.fingerprint}</code>
                    <span>
                      Added{" "}
                      {new Date(key.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    {key.lastUsedAt && (
                      <span>
                        — Last used{" "}
                        {new Date(key.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <form method="post" action={`/settings/keys/${key.id}/delete`}>
                  <button type="submit" class="btn btn-danger btn-sm">
                    Delete
                  </button>
                </form>
              </div>
            ))
          )}
        </div>

        <h3 style="margin-top: 24px">Add new SSH key</h3>
        <form method="post" action="/settings/keys">
          <div class="form-group">
            <label for="title">Title</label>
            <input
              type="text"
              id="title"
              name="title"
              required
              placeholder="e.g. My laptop"
            />
          </div>
          <div class="form-group">
            <label for="public_key">Public key</label>
            <textarea
              id="public_key"
              name="public_key"
              rows={4}
              required
              placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."
              style="font-family: var(--font-mono); font-size: 12px"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Add SSH key
          </button>
        </form>
      </div>
    </Layout>
  );
});

settings.post("/settings/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const publicKey = String(body.public_key || "").trim();

  if (!title || !publicKey) {
    return c.redirect("/settings/keys?error=Title+and+key+are+required");
  }

  // Basic validation
  if (
    !publicKey.startsWith("ssh-rsa ") &&
    !publicKey.startsWith("ssh-ed25519 ") &&
    !publicKey.startsWith("ecdsa-sha2-")
  ) {
    return c.redirect("/settings/keys?error=Invalid+SSH+public+key+format");
  }

  // Generate a simple fingerprint (hash of key data)
  const keyData = publicKey.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/=+$/, "");

  await db.insert(sshKeys).values({
    userId: user.id,
    title,
    fingerprint,
    publicKey,
  });

  return c.redirect("/settings/keys?success=SSH+key+added");
});

settings.post("/settings/keys/:id/delete", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  // Verify ownership
  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.redirect("/settings/keys?error=Key+not+found");
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.redirect("/settings/keys?success=SSH+key+deleted");
});

// SSH Keys API
settings.get("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const keys = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.userId, user.id));
  return c.json(keys);
});

settings.post("/api/user/keys", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ title: string; public_key: string }>();

  if (!body.title || !body.public_key) {
    return c.json({ error: "title and public_key are required" }, 400);
  }

  const keyData = body.public_key.split(" ")[1] || "";
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyData)
  );
  const fingerprint =
    "SHA256:" +
    btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replace(/=+$/, "");

  const [key] = await db
    .insert(sshKeys)
    .values({
      userId: user.id,
      title: body.title,
      fingerprint,
      publicKey: body.public_key,
    })
    .returning();

  return c.json(key, 201);
});

settings.delete("/api/user/keys/:id", async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("id");

  const [key] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.id, keyId))
    .limit(1);

  if (!key || key.userId !== user.id) {
    return c.json({ error: "Key not found" }, 404);
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
  return c.json({ deleted: true });
});

export default settings;
