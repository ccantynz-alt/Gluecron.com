/**
 * Block M2 addendum — Browser push notification management.
 *
 * Routes:
 *   GET  /settings/notifications/push  — UI page (enable / manage subscriptions)
 *   POST /api/push/subscribe           — save a PushSubscription (requireAuth)
 *   POST /api/push/unsubscribe         — remove a subscription (requireAuth)
 *   POST /api/push/test                — send a test notification (requireAuth)
 *
 * VAPID: handled by src/lib/push.ts (pure Web Crypto, no npm dep required).
 * All four keys land in process.env.VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
 * When the keys are missing the lib falls back to a process-stable generated
 * keypair with a console.warn — subscriptions work but break on restart.
 *
 * The subscription CRUD is delegated to src/lib/push-notify.ts which wraps
 * src/lib/push.ts and exposes the inline-defined pushSubscriptions table.
 *
 * CSS: every class is prefixed `.pn-*` to avoid collisions with existing
 * surfaces. No existing file is modified.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  savePushSubscription,
  deletePushSubscription,
  listPushSubscriptions,
  sendPushNotification,
  type PushSubscriptionRow,
} from "../lib/push-notify";
import { getVapidPublicKey } from "../lib/push";

const pushNotifRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Middleware — scoped; never "*"
// ---------------------------------------------------------------------------

pushNotifRoutes.use("/settings/notifications/push*", softAuth);
pushNotifRoutes.use("/api/push/*", requireAuth);

// ---------------------------------------------------------------------------
// Inline CSS — .pn-* namespace
// ---------------------------------------------------------------------------

const PN_STYLES = `
/* ── push-notifications page ── */
.pn-wrap {
  max-width: 760px;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4);
}

/* Hero / breadcrumb */
.pn-hero {
  margin-bottom: var(--space-6);
}
.pn-crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: var(--space-3);
}
.pn-crumbs a { color: var(--text-muted); text-decoration: none; }
.pn-crumbs a:hover { color: var(--text); text-decoration: underline; }
.pn-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 6px;
}
.pn-sub {
  font-size: 14px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.55;
}

/* Status banner */
.pn-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  margin-bottom: var(--space-4);
  background: rgba(63,185,80,0.08);
  border: 1px solid rgba(63,185,80,0.25);
  color: var(--text);
}
.pn-banner.is-error {
  background: rgba(248,81,73,0.08);
  border-color: rgba(248,81,73,0.25);
}
.pn-banner-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #3fb950;
  flex-shrink: 0;
}
.pn-banner.is-error .pn-banner-dot { background: #f85149; }

/* Card */
.pn-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: var(--space-5);
  margin-bottom: var(--space-4);
}
.pn-card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 4px;
}
.pn-card-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0 0 var(--space-4);
  line-height: 1.5;
}

/* Enable button */
.pn-enable-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.pn-enable-btn:hover { background: var(--accent-hover); }
.pn-enable-btn:disabled { opacity: 0.55; cursor: default; }

.pn-secondary-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 13px;
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.pn-secondary-btn:hover { color: var(--text); border-color: var(--text-muted); }

/* Subscription list */
.pn-sub-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pn-sub-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}
.pn-sub-meta {
  min-width: 0;
}
.pn-sub-endpoint {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 420px;
}
.pn-sub-date {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 2px;
}
.pn-remove-btn {
  flex-shrink: 0;
  padding: 4px 10px;
  background: transparent;
  color: #f85149;
  border: 1px solid rgba(248,81,73,0.35);
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.pn-remove-btn:hover { background: rgba(248,81,73,0.08); }

/* Events grid */
.pn-events-grid {
  display: grid;
  gap: 10px;
}
.pn-event-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.pn-event-icon {
  font-size: 18px;
  line-height: 1;
  margin-top: 1px;
  flex-shrink: 0;
}
.pn-event-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.pn-event-hint {
  font-size: 12px;
  color: var(--text-muted);
}

/* Empty state */
.pn-empty {
  text-align: center;
  padding: var(--space-5) var(--space-4);
  color: var(--text-muted);
  font-size: 14px;
}

/* Inline JS status */
#pn-js-status {
  font-size: 13px;
  margin-top: var(--space-3);
  color: var(--text-muted);
  min-height: 1.4em;
}
#pn-js-status.ok  { color: #3fb950; }
#pn-js-status.err { color: #f85149; }
`;

// ---------------------------------------------------------------------------
// Helper: format a subscription row for display
// ---------------------------------------------------------------------------

function fmtEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.host}${u.pathname.slice(0, 32)}…`;
  } catch {
    return endpoint.slice(0, 48) + "…";
  }
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// GET /settings/notifications/push
// ---------------------------------------------------------------------------

pushNotifRoutes.get("/settings/notifications/push", requireAuth, async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const subs: PushSubscriptionRow[] = await listPushSubscriptions(user.id);

  let vapidPublicKey = "";
  try {
    vapidPublicKey = await getVapidPublicKey();
  } catch {
    vapidPublicKey = "";
  }

  return c.html(
    <Layout title="Push notifications" user={user}>
      <style dangerouslySetInnerHTML={{ __html: PN_STYLES }} />
      <div class="pn-wrap">
        {/* Breadcrumb / hero */}
        <div class="pn-hero">
          <nav class="pn-crumbs" aria-label="Breadcrumb">
            <a href="/settings">Settings</a>
            <span>/</span>
            <a href="/settings/notifications">Notifications</a>
            <span>/</span>
            <span>Push</span>
          </nav>
          <h1 class="pn-title">Browser push notifications</h1>
          <p class="pn-sub">
            Subscribe this browser to receive push notifications for deploys,
            gate failures, PR merges, and AI reviews — even when Gluecron is
            not open.
          </p>
        </div>

        {/* Banner */}
        {success && (
          <div class="pn-banner" role="status">
            <span class="pn-banner-dot" aria-hidden="true" />
            {decodeURIComponent(success)}
          </div>
        )}
        {error && (
          <div class="pn-banner is-error" role="alert">
            <span class="pn-banner-dot" aria-hidden="true" />
            {decodeURIComponent(error)}
          </div>
        )}

        {/* Subscribe card */}
        <div class="pn-card">
          <h2 class="pn-card-title">Subscribe this browser</h2>
          <p class="pn-card-sub">
            Click the button below to request permission and register this
            browser. You can subscribe multiple devices independently.
          </p>

          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button
              type="button"
              class="pn-enable-btn"
              id="pn-subscribe-btn"
              data-vapid={vapidPublicKey}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 16a2 2 0 002-2H6a2 2 0 002 2zm.995-14.901a1 1 0 10-1.99 0A5.002 5.002 0 003 6c0 1.098-.5 6-2 7h14c-1.5-1-2-5.902-2-7 0-2.42-1.72-4.44-4.005-4.901z"/>
              </svg>
              Enable push on this browser
            </button>
            <button
              type="button"
              class="pn-secondary-btn"
              id="pn-test-btn"
              style="display:none"
            >
              Send test notification
            </button>
          </div>
          <p id="pn-js-status" aria-live="polite"></p>
        </div>

        {/* Tracked events */}
        <div class="pn-card">
          <h2 class="pn-card-title">Tracked events</h2>
          <p class="pn-card-sub">
            These events will trigger a push notification when they occur.
            Per-event toggles live in{" "}
            <a href="/settings/notifications" style="color:var(--accent)">
              Notification preferences
            </a>
            .
          </p>
          <ul class="pn-events-grid" aria-label="Push events">
            <li class="pn-event-row">
              <span class="pn-event-icon" aria-hidden="true">🚀</span>
              <div>
                <div class="pn-event-label">Deploy succeeded</div>
                <div class="pn-event-hint">
                  Your push went live — includes a link to the push watch page.
                </div>
              </div>
            </li>
            <li class="pn-event-row">
              <span class="pn-event-icon" aria-hidden="true">🚨</span>
              <div>
                <div class="pn-event-label">Gate failed</div>
                <div class="pn-event-hint">
                  A security or quality gate rejected your push.
                </div>
              </div>
            </li>
            <li class="pn-event-row">
              <span class="pn-event-icon" aria-hidden="true">✅</span>
              <div>
                <div class="pn-event-label">PR merged</div>
                <div class="pn-event-hint">
                  One of your pull requests was merged.
                </div>
              </div>
            </li>
            <li class="pn-event-row">
              <span class="pn-event-icon" aria-hidden="true">🤖</span>
              <div>
                <div class="pn-event-label">AI review posted</div>
                <div class="pn-event-hint">
                  The AI reviewer completed a pass on your PR.
                </div>
              </div>
            </li>
          </ul>
        </div>

        {/* Active subscriptions */}
        <div class="pn-card">
          <h2 class="pn-card-title">Active subscriptions</h2>
          <p class="pn-card-sub">
            Each row is a browser/device that will receive notifications.
            Stale endpoints are cleaned up automatically after a failed
            delivery.
          </p>
          {subs.length === 0 ? (
            <p class="pn-empty">No active push subscriptions yet.</p>
          ) : (
            <ul class="pn-sub-list" aria-label="Active subscriptions">
              {subs.map((s) => (
                <li class="pn-sub-item" key={s.id}>
                  <div class="pn-sub-meta">
                    <div class="pn-sub-endpoint" title={s.endpoint}>
                      {fmtEndpoint(s.endpoint)}
                    </div>
                    {s.userAgent && (
                      <div class="pn-sub-date" title={s.userAgent}>
                        {s.userAgent.slice(0, 60)}
                      </div>
                    )}
                    <div class="pn-sub-date">Added {fmtDate(s.createdAt)}</div>
                  </div>
                  <form method="post" action="/api/push/unsubscribe">
                    <input type="hidden" name="endpoint" value={s.endpoint} />
                    <button type="submit" class="pn-remove-btn" aria-label="Remove subscription">
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Client-side subscription logic */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function () {
  var btn = document.getElementById('pn-subscribe-btn');
  var testBtn = document.getElementById('pn-test-btn');
  var status = document.getElementById('pn-js-status');
  var vapidKey = btn ? btn.getAttribute('data-vapid') : '';

  function setStatus(msg, cls) {
    if (!status) return;
    status.textContent = msg;
    status.className = cls || '';
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // Check if already subscribed
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.ready.then(function(reg) {
      reg.pushManager.getSubscription().then(function(sub) {
        if (sub && testBtn) {
          testBtn.style.display = 'inline-flex';
          setStatus('This browser is subscribed.', 'ok');
        }
      }).catch(function() {});
    }).catch(function() {});
  } else {
    setStatus('Push notifications are not supported in this browser.', 'err');
    if (btn) btn.disabled = true;
  }

  if (btn) {
    btn.addEventListener('click', function () {
      if (!('serviceWorker' in navigator && 'PushManager' in window)) {
        setStatus('Push notifications are not supported in this browser.', 'err');
        return;
      }
      if (!vapidKey) {
        setStatus('Push notifications require server configuration (VAPID keys missing).', 'err');
        return;
      }
      btn.disabled = true;
      setStatus('Requesting permission…');

      Notification.requestPermission().then(function(perm) {
        if (perm !== 'granted') {
          setStatus('Permission denied. Allow notifications in your browser settings.', 'err');
          btn.disabled = false;
          return;
        }
        return navigator.serviceWorker.ready.then(function(reg) {
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
          });
        }).then(function(sub) {
          var raw = sub.toJSON();
          setStatus('Registering…');
          return fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              endpoint: raw.endpoint,
              keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth },
            }),
          });
        }).then(function(res) {
          if (res.ok) {
            setStatus('Subscribed! Reload to see this device in the list.', 'ok');
            if (testBtn) testBtn.style.display = 'inline-flex';
            btn.disabled = false;
          } else {
            return res.json().then(function(j) {
              setStatus('Subscribe failed: ' + (j.error || res.status), 'err');
              btn.disabled = false;
            });
          }
        }).catch(function(err) {
          setStatus('Subscribe failed: ' + (err.message || err), 'err');
          btn.disabled = false;
        });
      }).catch(function(err) {
        setStatus('Permission request failed: ' + (err.message || err), 'err');
        btn.disabled = false;
      });
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', function () {
      testBtn.disabled = true;
      setStatus('Sending test…');
      fetch('/api/push/test', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(j) {
          if (j.sent > 0) {
            setStatus('Test notification sent! Check your browser.', 'ok');
          } else if (j.failed > 0) {
            setStatus('Delivery failed (sent:0 failed:' + j.failed + '). Check VAPID keys.', 'err');
          } else {
            setStatus('No active subscriptions found — subscribe this browser first.', 'err');
          }
          testBtn.disabled = false;
        })
        .catch(function(err) {
          setStatus('Test failed: ' + (err.message || err), 'err');
          testBtn.disabled = false;
        });
    });
  }
})();
`,
        }}
      />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /api/push/subscribe
// ---------------------------------------------------------------------------

pushNotifRoutes.post("/api/push/subscribe", async (c) => {
  const user = c.get("user")!;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const b = body as Record<string, unknown>;
  const endpoint = typeof b?.endpoint === "string" ? b.endpoint.trim() : "";
  const keys = b?.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys?.auth === "string" ? keys.auth.trim() : "";

  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "invalid_subscription" }, 400);
  }

  const ua = c.req.header("user-agent") ?? undefined;

  try {
    await savePushSubscription(user.id, { endpoint, keys: { p256dh, auth } }, ua);
  } catch {
    return c.json({ error: "subscribe_failed" }, 500);
  }

  return c.json({ ok: true }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/push/unsubscribe
// ---------------------------------------------------------------------------

pushNotifRoutes.post("/api/push/unsubscribe", async (c) => {
  // Accept both form data (from the HTML form) and JSON.
  let endpoint = "";
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    endpoint =
      typeof (body as Record<string, unknown>)?.endpoint === "string"
        ? ((body as Record<string, unknown>).endpoint as string).trim()
        : "";
  } else {
    // form submission
    const form = await c.req.formData();
    endpoint = (form.get("endpoint") as string | null)?.trim() ?? "";
  }

  if (!endpoint) {
    return c.json({ error: "missing_endpoint" }, 400);
  }

  await deletePushSubscription(endpoint);

  // If this was a form submission, redirect back.
  if (!ct.includes("application/json")) {
    return c.redirect(
      "/settings/notifications/push?success=" +
        encodeURIComponent("Subscription removed."),
      303
    );
  }

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// POST /api/push/test
// ---------------------------------------------------------------------------

pushNotifRoutes.post("/api/push/test", async (c) => {
  const user = c.get("user")!;
  const result = await sendPushNotification(user.id, {
    title: "Gluecron test notification",
    body: "If you can read this, push delivery is working on this device.",
    url: "/settings/notifications/push",
  });
  return c.json(result);
});

export default pushNotifRoutes;
