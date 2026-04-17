/**
 * Barrel for the K-series agents (Wave 2+).
 *
 * Each agent lives in its own file under this directory and re-exports its
 * public entry function here. Add new exports below — do NOT replace the file
 * when landing another agent.
 */

export {
  runTriageAgent,
  normaliseTriagePayload,
  validateTriageArgs,
  estimateHaikuCents,
  renderTriageComment,
  buildRunSummary,
  type RunTriageAgentArgs,
  type RunTriageAgentResult,
  type TriageClassification,
  type TriageCategory,
  type TriageComplexity,
  type TriagePriority,
  type TriageItemKind,
} from "./triage-agent";

export { runReviewResponseAgent } from "./review-response-agent";

export {
  runHealBot,
  runHealBotForAll,
  renderHealBotPrBody,
  renderHealBotPrTitle,
  buildHealBotSummary,
  HEAL_BOT_SLUG,
  HEAL_BOT_BOT_USERNAME,
  type RunHealBotArgs,
  type RunHealBotResult,
  type RunHealBotForAllResult,
} from "./heal-bot";

export {
  runFixAgent,
  renderFixAgentComment,
  buildFixAgentSummary,
  FIX_AGENT_COST_CENTS,
  FIX_AGENT_MAX_REPAIRS_IN_COMMENT,
  FIX_AGENT_SLUG,
  FIX_AGENT_BOT_USERNAME,
  type RunFixAgentArgs,
  type RunFixAgentResult,
} from "./fix-agent";

export {
  runDeployWatcher,
  renderIncidentIssueBody,
  buildDeployWatcherSummary,
  shouldRollback,
  DEPLOY_WATCHER_COST_CENTS,
  DEPLOY_WATCHER_ERROR_THRESHOLD,
  DEPLOY_WATCHER_WINDOW_MS,
  DEPLOY_WATCHER_POLL_MS,
  DEPLOY_WATCHER_SLUG,
  DEPLOY_WATCHER_BOT_USERNAME,
  type RunDeployWatcherArgs,
  type RunDeployWatcherResult,
} from "./deploy-watcher";
