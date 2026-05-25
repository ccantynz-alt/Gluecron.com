/**
 * Agent multiplayer — Bearer-token auth middleware.
 *
 * Sits in front of the v2 API. When the caller presents
 * `Authorization: Bearer agt_<hex>`, we resolve the row from
 * `agent_sessions` and stash it on the request context as
 * `c.set("agent", session)`. Downstream handlers can then:
 *   - charge the session's budget,
 *   - enforce the branch namespace on ref updates,
 *   - rate-limit by agent rather than by user.
 *
 * If the header isn't an `agt_` token (or it doesn't validate), we
 * call next() unchanged so the regular `apiAuth` middleware can pick
 * up the PAT/OAuth/session flow.
 *
 * The middleware never rejects on a bad agent token — it just falls
 * through and lets the canonical auth middleware decide. This keeps
 * the matrix of "what the caller can do" centralised in `apiAuth`.
 */

import { createMiddleware } from "hono/factory";
import {
  AGENT_TOKEN_PREFIX,
  authenticateAgent,
  isAgentToken,
  refIsInNamespace,
} from "../lib/agent-multiplayer";
import type { AgentSession } from "../db/schema";

export type AgentAuthEnv = {
  Variables: {
    agent?: AgentSession | null;
  };
};

/**
 * Detect and resolve an agent Bearer token. Always calls next();
 * downstream auth handles the non-agent paths.
 */
export const agentAuth = createMiddleware<AgentAuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return next();
  }
  const token = authHeader.slice(7).trim();
  if (!token.startsWith(AGENT_TOKEN_PREFIX) || !isAgentToken(token)) {
    return next();
  }

  const session = await authenticateAgent(token);
  if (session) {
    c.set("agent", session);
  }
  return next();
});

/**
 * Guard: require an authenticated agent on this route. Returns 401
 * when no agent is on the context.
 */
export const requireAgentAuth = createMiddleware<AgentAuthEnv>(
  async (c, next) => {
    const agent = c.get("agent");
    if (!agent) {
      return c.json(
        {
          error: "Agent authentication required",
          hint: "Use Authorization: Bearer agt_<token>",
        },
        401
      );
    }
    return next();
  }
);

/**
 * Branch-namespace guard for PATCH /repos/:owner/:repo/git/refs/heads/:branch.
 * When the caller authenticated as an agent, the target branch must sit
 * under the agent's `branch_namespace` prefix. Non-agent callers
 * (sessions, PATs) are passed through unchanged.
 *
 * This is mounted on the v2 git-refs path; it never blocks regular
 * humans.
 */
export const enforceAgentBranchNamespace = createMiddleware<AgentAuthEnv>(
  async (c, next) => {
    const agent = c.get("agent");
    if (!agent) return next();
    const branch = c.req.param("branch");
    if (!branch) return next();
    if (!refIsInNamespace(branch, agent.branchNamespace)) {
      return c.json(
        {
          error: "Branch is outside the agent's namespace",
          namespace: agent.branchNamespace,
          branch,
        },
        403
      );
    }
    return next();
  }
);
