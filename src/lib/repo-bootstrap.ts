/**
 * Repo bootstrap — wires up the "full green ecosystem by default" stance.
 *
 * Called immediately after a new repository row is created (including on fork).
 * Every setting defaults to the most protective configuration — all gates on,
 * auto-repair on, auto-deploy gated on all-green. Owners can turn things off
 * in settings but they never have to turn things on.
 *
 * This is the heart of the "nothing broken reaches the customer" posture.
 */

import { db } from "../db";
import {
  repoSettings,
  branchProtection,
  labels,
  issues,
  issueComments,
} from "../db/schema";
import { audit } from "./notify";

const DEFAULT_LABELS = [
  { name: "bug", color: "#f85149", description: "Something is broken" },
  { name: "feature", color: "#1f6feb", description: "New capability" },
  { name: "enhancement", color: "#58a6ff", description: "Improvement to existing behaviour" },
  { name: "security", color: "#d29922", description: "Security-related" },
  { name: "performance", color: "#a371f7", description: "Performance-related" },
  { name: "docs", color: "#3fb950", description: "Documentation" },
  { name: "question", color: "#8b949e", description: "Further info requested" },
  { name: "good first issue", color: "#7ee787", description: "Suitable for new contributors" },
  { name: "ai-triaged", color: "#bc8cff", description: "Auto-triaged by GlueCron AI" },
];

const WELCOME_BODY = `Welcome to your new GlueCron repository.

Every repository ships with the **full green ecosystem** enabled by default — nothing broken ever reaches your customers.

## What's enabled out of the box

- **AI code review** on every pull request
- **Green gate enforcement** — GateTest + AI review + merge check must all pass before merge
- **Secret & security scanning** on every push
- **Automated merge conflict resolution** when conflicts arise
- **AI auto-repair** — failing gates trigger a fix attempt before a human is pinged
- **Branch protection** on \`main\` — PR required, all gates green, AI approval required
- **Auto-deploy** to Crontech on every passing push to \`main\`
- **AI commit messages, PR summaries, and release changelogs** on demand

You can toggle any of this in **Settings → Gates & Auto-repair**. The safe defaults are on.

## Quick start

Push your first commit:

\`\`\`
git remote add gluecron https://gluecron.com/YOUR_USERNAME/YOUR_REPO.git
git push -u gluecron main
\`\`\`

Ask the assistant anything:

\`\`\`
Click "Ask AI" in the repo nav or press Cmd+K and type your question.
\`\`\`

Happy shipping.`;

export interface BootstrapResult {
  settingsCreated: boolean;
  protectionCreated: boolean;
  labelsCreated: number;
  welcomeIssueNumber?: number;
}

export async function bootstrapRepository(opts: {
  repositoryId: string;
  ownerUserId: string;
  defaultBranch?: string;
  skipWelcomeIssue?: boolean;
}): Promise<BootstrapResult> {
  const branch = opts.defaultBranch || "main";
  let settingsCreated = false;
  let protectionCreated = false;
  let labelsCreated = 0;
  let welcomeIssueNumber: number | undefined;

  // 1. Settings — all gates on, all AI features on
  try {
    await db.insert(repoSettings).values({
      repositoryId: opts.repositoryId,
    });
    settingsCreated = true;
  } catch (err) {
    // Ignore unique-violation if settings already exist (fork case)
    console.warn("[bootstrap] settings:", (err as Error).message);
  }

  // 2. Branch protection on the default branch — maximum safety
  try {
    await db.insert(branchProtection).values({
      repositoryId: opts.repositoryId,
      pattern: branch,
      requirePullRequest: true,
      requireGreenGates: true,
      requireAiApproval: true,
      requireHumanReview: false,
      requiredApprovals: 0,
      allowForcePush: false,
      allowDeletion: false,
      dismissStaleReviews: true,
    });
    protectionCreated = true;
  } catch (err) {
    console.warn("[bootstrap] protection:", (err as Error).message);
  }

  // 3. Default labels
  try {
    const rows = DEFAULT_LABELS.map((l) => ({
      repositoryId: opts.repositoryId,
      name: l.name,
      color: l.color,
      description: l.description,
    }));
    await db.insert(labels).values(rows).onConflictDoNothing?.();
    labelsCreated = rows.length;
  } catch (err) {
    // onConflictDoNothing might not be available on all drizzle adapters; best-effort insert
    for (const l of DEFAULT_LABELS) {
      try {
        await db.insert(labels).values({
          repositoryId: opts.repositoryId,
          name: l.name,
          color: l.color,
          description: l.description,
        });
        labelsCreated++;
      } catch {
        // already exists — ignore
      }
    }
  }

  // 4. Welcome issue (skippable for forks)
  if (!opts.skipWelcomeIssue) {
    try {
      const [issue] = await db
        .insert(issues)
        .values({
          repositoryId: opts.repositoryId,
          authorId: opts.ownerUserId,
          title: "Welcome to GlueCron",
          body: WELCOME_BODY,
          state: "open",
        })
        .returning();
      welcomeIssueNumber = issue?.number;
    } catch (err) {
      console.warn("[bootstrap] welcome issue:", (err as Error).message);
    }
  }

  await audit({
    userId: opts.ownerUserId,
    repositoryId: opts.repositoryId,
    action: "repo.bootstrap",
    metadata: {
      settingsCreated,
      protectionCreated,
      labelsCreated,
      welcomeIssueNumber,
    },
  });

  return {
    settingsCreated,
    protectionCreated,
    labelsCreated,
    welcomeIssueNumber,
  };
}

/**
 * Convenience helper to load settings (creates defaults if missing).
 */
export async function getOrCreateSettings(repositoryId: string) {
  const { eq } = await import("drizzle-orm");
  const [existing] = await db
    .select()
    .from(repoSettings)
    .where(eq(repoSettings.repositoryId, repositoryId))
    .limit(1);
  if (existing) return existing;

  try {
    const [row] = await db
      .insert(repoSettings)
      .values({ repositoryId })
      .returning();
    return row;
  } catch {
    // Race — someone else inserted, re-select
    const [row] = await db
      .select()
      .from(repoSettings)
      .where(eq(repoSettings.repositoryId, repositoryId))
      .limit(1);
    return row;
  }
}
