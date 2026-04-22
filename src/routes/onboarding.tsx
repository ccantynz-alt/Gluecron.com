/**
 * Onboarding flow — guided setup for new users.
 *
 * Goal: get a fresh user from 0 to first repo in <60 seconds.
 * Headline + 1-line value prop + 3 concrete next-step CTAs + skip-to-dashboard.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, sshKeys, apiTokens, users } from "../db/schema";
import { config } from "../lib/config";
import {
  Container,
  WelcomeHero,
  StepIndicator,
  Card,
  Flex,
  Text,
  LinkButton,
  CopyBlock,
  Kbd,
  Spacer,
} from "../views/ui";

const onboardingRoutes = new Hono<AuthEnv>();

onboardingRoutes.get("/getting-started", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;

  // Check what the user has done
  let repoCount = 0;
  let hasKeys = false;
  let hasTokens = false;

  try {
    const [repos] = await db
      .select({ count: sql<number>`count(*)` })
      .from(repositories)
      .where(eq(repositories.ownerId, user.id));
    repoCount = repos?.count ?? 0;

    const [keys] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sshKeys)
      .where(eq(sshKeys.userId, user.id));
    hasKeys = (keys?.count ?? 0) > 0;

    const [tokens] = await db
      .select({ count: sql<number>`count(*)` })
      .from(apiTokens)
      .where(eq(apiTokens.userId, user.id));
    hasTokens = (tokens?.count ?? 0) > 0;
  } catch { /* DB may not be ready */ }

  const firstRun = repoCount === 0;

  return c.html(
    <Layout title="Getting Started" user={user}>
      <Container maxWidth={760}>
        {/* ─── Welcome headline + 1-line value prop ─── */}
        <WelcomeHero
          title={firstRun ? `Welcome, ${user.username}` : "Finish setting up"}
          subtitle="Ship safer code with AI-native hosting, automated CI, and push-time gates."
        />

        {/* ─── Three concrete next-step CTAs — the 60-second path ─── */}
        {firstRun && (
          <div class="panel" style="margin-bottom:20px">
            <div class="panel-item" style="flex-direction:column;align-items:stretch;gap:4px;padding:16px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:15px;font-weight:600">Create a new repository</div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                    Start from scratch. Green-ecosystem defaults, branch protection, labels, CODEOWNERS — all wired on day one.
                  </div>
                </div>
                <a href="/new" class="btn btn-primary">Create repo</a>
              </div>
            </div>
            <div class="panel-item" style="flex-direction:column;align-items:stretch;gap:4px;padding:16px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:15px;font-weight:600">Import from GitHub</div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                    Mirror an existing repo by URL. History, branches, and tags come across on the first sync.
                  </div>
                </div>
                <a href="/import" class="btn">Import repo</a>
              </div>
            </div>
            <div class="panel-item" style="flex-direction:column;align-items:stretch;gap:4px;padding:16px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div style="flex:1">
                  <div style="font-size:15px;font-weight:600">Browse public repos</div>
                  <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                    See what others are building. Fork or star without leaving the platform.
                  </div>
                </div>
                <a href="/explore" class="btn">Browse</a>
              </div>
            </div>
          </div>
        )}

        {/* ─── Existing users: show remaining setup as a compact checklist ─── */}
        {!firstRun && (
          <div class="panel" style="margin-bottom:20px">
            <div class="panel-item" style="justify-content:space-between;padding:14px 16px">
              <div>
                <div style="font-size:14px;font-weight:600">
                  {"✓"} You have {repoCount} repositor{repoCount === 1 ? "y" : "ies"}
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  Push code, open issues, review PRs.
                </div>
              </div>
              <a href="/dashboard" class="btn btn-sm">Open dashboard</a>
            </div>
            <div class="panel-item" style="justify-content:space-between;padding:14px 16px">
              <div>
                <div style="font-size:14px;font-weight:600">
                  {hasKeys ? "✓ SSH key added" : "Add an SSH key"}
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  {hasKeys ? "Push without passwords." : "Push without entering a password every time."}
                </div>
              </div>
              {!hasKeys && <a href="/settings/keys" class="btn btn-sm">Add key</a>}
            </div>
            <div class="panel-item" style="justify-content:space-between;padding:14px 16px">
              <div>
                <div style="font-size:14px;font-weight:600">
                  {hasTokens ? "✓ API token ready" : "Create an API token"}
                </div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  {hasTokens ? "Use it for CI, CLI, and automation." : "Authenticate scripts, CI, and the CLI."}
                </div>
              </div>
              {!hasTokens && <a href="/settings/tokens" class="btn btn-sm">Create token</a>}
            </div>
          </div>
        )}

        {/* ─── Push snippet (only once the user has at least one repo) ─── */}
        {!firstRun && (
          <Card style="padding:16px;margin-bottom:20px">
            <h3 style="font-size:14px;margin:0 0 8px 0">Push an existing project</h3>
            <CopyBlock
              text={`git remote add gluecron ${config.appBaseUrl}/${user.username}/your-repo.git\ngit push -u gluecron main`}
              label="Commands"
            />
          </Card>
        )}

        {/* ─── All done celebration ─── */}
        {repoCount > 0 && hasKeys && hasTokens && (
          <Card style="text-align:center;padding:32px 0;border-color:var(--green);margin-bottom:20px;background:rgba(63,185,80,0.05)">
            <div style="font-size:40px;margin-bottom:8px">&#127881;</div>
            <h2 style="margin:0">You're all set.</h2>
            <Text size={13} muted style="display:block;margin-top:6px">
              Setup complete. Start building.
            </Text>
            <Flex gap={12} justify="center" style="margin-top:16px">
              <LinkButton href="/dashboard" variant="primary">Open dashboard</LinkButton>
              <LinkButton href="/explore">Discover repos</LinkButton>
            </Flex>
          </Card>
        )}

        {/* ─── Skip-to-dashboard + help ─── */}
        <div style="text-align:center;padding:16px 0 32px 0">
          <a href="/dashboard" style="font-size:13px;color:var(--text-muted);text-decoration:underline">
            Skip to dashboard {"→"}
          </a>
          <div style="margin-top:12px">
            <Text size={12} muted>
              Need help? See the <a href="/api/docs">API docs</a> or press <Kbd>?</Kbd> for shortcuts.
            </Text>
          </div>
        </div>
      </Container>
    </Layout>
  );
});

export default onboardingRoutes;
