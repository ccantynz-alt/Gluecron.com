/**
 * Onboarding flow — guided setup for new users.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, sshKeys, apiTokens, users } from "../db/schema";

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

  const steps = [
    { label: "Create account", completed: true, active: false },
    { label: "Create a repository", completed: repoCount > 0, active: repoCount === 0 },
    { label: "Push your code", completed: false, active: repoCount > 0 },
    { label: "Set up SSH key", completed: hasKeys, active: !hasKeys && repoCount > 0 },
    { label: "Create API token", completed: hasTokens, active: !hasTokens && hasKeys },
  ];

  const activeStep = steps.findIndex((s) => s.active);

  return c.html(
    <Layout title="Getting Started" user={user}>
      <div style="max-width:700px;margin:0 auto">
        <div style="text-align:center;padding:40px 0 32px">
          <h1 style="font-size:32px;margin-bottom:8px">Welcome to gluecron</h1>
          <p style="font-size:16px;color:var(--text-muted)">Let's get you set up in a few steps.</p>
        </div>

        <div style="display:flex;align-items:center;justify-content:center;gap:0;margin-bottom:40px">
          {steps.map((step, i) => (
            <>
              {i > 0 && (
                <div style={`flex:1;height:2px;background:${step.completed || steps[i - 1].completed ? "var(--green)" : "var(--border)"};min-width:30px`} />
              )}
              <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
                <div style={`width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;${step.completed ? "background:var(--green);border:2px solid var(--green);color:#fff" : step.active ? "border:2px solid var(--accent);color:var(--accent);background:transparent" : "border:2px solid var(--border);color:var(--text-muted);background:transparent"}`}>
                  {step.completed ? "\u2713" : i + 1}
                </div>
                <span style={`font-size:11px;white-space:nowrap;${step.active ? "color:var(--text);font-weight:500" : "color:var(--text-muted)"}`}>
                  {step.label}
                </span>
              </div>
            </>
          ))}
        </div>

        {/* Step 1: Create repository */}
        {activeStep <= 1 && repoCount === 0 && (
          <StepCard
            number={1}
            title="Create your first repository"
            description="A repository contains all your project files, including the revision history."
            active
          >
            <a href="/new" class="btn btn-primary" style="margin-top:12px">Create repository</a>
          </StepCard>
        )}

        {/* Step 2: Push code */}
        {repoCount > 0 && (
          <StepCard
            number={2}
            title="Push your code"
            description="Connect your local repository and push your first commit."
          >
            <pre style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px;font-family:var(--font-mono);font-size:13px;margin-top:12px;line-height:1.8;overflow-x:auto">{`# Add the remote
git remote add gluecron http://localhost:3000/${user.username}/your-repo.git

# Push your code
git push -u gluecron main`}</pre>
            <button type="button" class="btn btn-sm" data-clipboard={`git remote add gluecron http://localhost:3000/${user.username}/your-repo.git\ngit push -u gluecron main`} style="margin-top:8px">
              Copy commands
            </button>
          </StepCard>
        )}

        {/* Step 3: SSH key */}
        <StepCard
          number={3}
          title={hasKeys ? "SSH key added \u2713" : "Add an SSH key"}
          description={hasKeys ? "Your SSH key is configured." : "SSH keys let you push code securely without entering your password."}
          completed={hasKeys}
        >
          {!hasKeys && (
            <>
              <pre style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius);padding:16px;font-family:var(--font-mono);font-size:13px;margin-top:12px;line-height:1.8">{`# Generate a key (if you don't have one)
ssh-keygen -t ed25519 -C "your@email.com"

# Copy your public key
cat ~/.ssh/id_ed25519.pub`}</pre>
              <a href="/settings/keys" class="btn btn-primary btn-sm" style="margin-top:12px">Add SSH key</a>
            </>
          )}
        </StepCard>

        {/* Step 4: API token */}
        <StepCard
          number={4}
          title={hasTokens ? "API token created \u2713" : "Create an API token"}
          description={hasTokens ? "You have an API token configured." : "API tokens let you automate workflows and integrate with CI/CD."}
          completed={hasTokens}
        >
          {!hasTokens && (
            <>
              <p style="font-size:14px;color:var(--text-muted);margin-top:12px">
                Use tokens to authenticate with the gluecron API for scripting and automation.
              </p>
              <a href="/settings/tokens" class="btn btn-primary btn-sm" style="margin-top:12px">Create token</a>
            </>
          )}
        </StepCard>

        {/* All done */}
        {repoCount > 0 && hasKeys && hasTokens && (
          <div style="text-align:center;padding:40px 0;border:1px solid var(--green);border-radius:var(--radius);margin-top:24px;background:rgba(63,185,80,0.05)">
            <div style="font-size:48px;margin-bottom:12px">&#127881;</div>
            <h2>You're all set!</h2>
            <p style="color:var(--text-muted);margin-top:8px">You've completed the setup. Start building something great.</p>
            <div style="display:flex;gap:12px;justify-content:center;margin-top:20px">
              <a href="/" class="btn btn-primary">Go to dashboard</a>
              <a href="/api/docs" class="btn">Explore the API</a>
              <a href="/explore" class="btn">Discover repos</a>
            </div>
          </div>
        )}

        <div style="text-align:center;padding:32px 0;color:var(--text-muted);font-size:13px">
          <p>Need help? Check the <a href="/api/docs">API documentation</a> or press <kbd class="kbd">?</kbd> for keyboard shortcuts.</p>
        </div>
      </div>
    </Layout>
  );
});

const StepCard = ({
  number,
  title,
  description,
  active,
  completed,
  children,
}: {
  number: number;
  title: string;
  description: string;
  active?: boolean;
  completed?: boolean;
  children?: any;
}) => (
  <div
    style={`border:1px solid ${completed ? "var(--green)" : active ? "var(--accent)" : "var(--border)"};border-radius:var(--radius);padding:20px;margin-bottom:16px;${completed ? "opacity:0.7;" : ""}`}
  >
    <div style="display:flex;align-items:flex-start;gap:12px">
      <div
        style={`width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;${completed ? "background:var(--green);color:#fff" : "background:var(--bg-tertiary);color:var(--text-muted)"}`}
      >
        {completed ? "\u2713" : number}
      </div>
      <div style="flex:1">
        <h3 style="font-size:16px;margin-bottom:4px">{title}</h3>
        <p style="font-size:14px;color:var(--text-muted)">{description}</p>
        {children}
      </div>
    </div>
  </div>
);

export default onboardingRoutes;
