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
      <Container maxWidth={700}>
        <WelcomeHero title="Welcome to gluecron" subtitle="Let's get you set up in a few steps." />

        <div style="display:flex;justify-content:center;margin-bottom:40px">
          <StepIndicator steps={steps} />
        </div>

        {/* Step 1: Create repository */}
        {activeStep <= 1 && repoCount === 0 && (
          <StepCard
            number={1}
            title="Create your first repository"
            description="A repository contains all your project files, including the revision history."
            active
          >
            <Spacer size={12} />
            <LinkButton href="/new" variant="primary">Create repository</LinkButton>
          </StepCard>
        )}

        {/* Step 2: Push code */}
        {repoCount > 0 && (
          <StepCard
            number={2}
            title="Push your code"
            description="Connect your local repository and push your first commit."
          >
            <Spacer size={12} />
            <CopyBlock text={`git remote add gluecron http://localhost:3000/${user.username}/your-repo.git\ngit push -u gluecron main`} label="Commands" />
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
              <Spacer size={12} />
              <CopyBlock text={`ssh-keygen -t ed25519 -C "your@email.com"\ncat ~/.ssh/id_ed25519.pub`} label="Generate & copy key" />
              <Spacer size={12} />
              <LinkButton href="/settings/keys" variant="primary" size="sm">Add SSH key</LinkButton>
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
              <Spacer size={12} />
              <Text size={14} muted>
                Use tokens to authenticate with the gluecron API for scripting and automation.
              </Text>
              <Spacer size={12} />
              <LinkButton href="/settings/tokens" variant="primary" size="sm">Create token</LinkButton>
            </>
          )}
        </StepCard>

        {/* All done */}
        {repoCount > 0 && hasKeys && hasTokens && (
          <Card style="text-align:center;padding:40px 0;border-color:var(--green);margin-top:24px;background:rgba(63,185,80,0.05)">
            <div style="font-size:48px;margin-bottom:12px">&#127881;</div>
            <h2>You're all set!</h2>
            <Text size={14} muted style="display:block;margin-top:8px">You've completed the setup. Start building something great.</Text>
            <Flex gap={12} justify="center" style="margin-top:20px">
              <LinkButton href="/" variant="primary">Go to dashboard</LinkButton>
              <LinkButton href="/api/docs">Explore the API</LinkButton>
              <LinkButton href="/explore">Discover repos</LinkButton>
            </Flex>
          </Card>
        )}

        <div style="text-align:center;padding:32px 0">
          <Text size={13} muted>
            Need help? Check the <a href="/api/docs">API documentation</a> or press <Kbd>?</Kbd> for keyboard shortcuts.
          </Text>
        </div>
      </Container>
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
  <Card style={`border-color:${completed ? "var(--green)" : active ? "var(--accent)" : "var(--border)"};padding:20px;margin-bottom:16px;${completed ? "opacity:0.7;" : ""}`}>
    <Flex gap={12} align="flex-start">
      <div
        style={`width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;${completed ? "background:var(--green);color:#fff" : "background:var(--bg-tertiary);color:var(--text-muted)"}`}
      >
        {completed ? "\u2713" : number}
      </div>
      <div style="flex:1">
        <h3 style="font-size:16px;margin-bottom:4px">{title}</h3>
        <Text size={14} muted>{description}</Text>
        {children}
      </div>
    </Flex>
  </Card>
);

export default onboardingRoutes;
