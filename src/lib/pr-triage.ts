/**
 * PR triage — fire-and-forget hook that would suggest labels and reviewers.
 * Stub implementation: logs the request but does not call out to the AI yet.
 */

export interface PrTriageInput {
  ownerName: string;
  repoName: string;
  repositoryId: string;
  prId: string;
  prAuthorId: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
}

export async function triggerPrTriage(input: PrTriageInput): Promise<void> {
  // Intentionally a no-op for now; downstream consumers only await the
  // promise for catch handlers. The implementation will be filled in
  // alongside the AI triage pipeline.
  if (process.env.DEBUG_PR_TRIAGE === "1") {
    console.log(
      "[pr-triage] queued",
      input.ownerName,
      input.repoName,
      input.prId,
    );
  }
}
