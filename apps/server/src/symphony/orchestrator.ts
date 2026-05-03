/**
 * Pure orchestrator logic for Symphony runs.
 *
 * Given a run's lifecycle phase and thread output, decides the next action.
 * Side-effect free. The Effect Layer that wraps this calls into:
 *  - parsePlanFromOutput / parsePRUrlFromOutput from threadOutputParser.ts
 *  - linearWriter for any Linear-side write
 *  - codexAppServerManager to drive the next turn
 *
 * NOTE: The plan's spec uses `status: "planning" | "implementing"`, but the
 * actual contracts use `SymphonyLifecyclePhase` for phase-level state. This
 * module uses `lifecyclePhase` accordingly.
 *
 * NOTE(phase-4): The marker-based plan/PR-URL protocol (SYMPHONY_PLAN_BEGIN,
 * SYMPHONY_PR_URL) is the target format for Phase 4's prompt redesign.
 * Today's `reconcileRunWithThread` in Layers/SymphonyService.ts uses
 * `extractLatestPlanMarkdown` / `extractReviewOutcome` from phaseOutput.ts
 * instead. This module is the pure decision layer that Phase 4 will wire up
 * once the prompts emit these markers consistently.
 */

import type { SymphonyLifecyclePhase, SymphonyRunStatus } from "@t3tools/contracts";

import { parsePlanFromOutput, parsePRUrlFromOutput } from "./threadOutputParser.ts";

export interface OrchestratorInput {
  readonly run: {
    readonly runId: string;
    readonly issueId: string;
    /**
     * The high-level run status (e.g. "running", "review-ready").
     * Use `lifecyclePhase` for fine-grained phase-level decisions.
     */
    readonly status: SymphonyRunStatus;
    /**
     * The phase-level state (e.g. "planning", "implementing", "reviewing").
     * This is what drives the orchestrator's phase-transition logic.
     */
    readonly lifecyclePhase: SymphonyLifecyclePhase;
    readonly archivedAt: string | null;
    readonly lastSeenLinearState: string | null;
  };
  readonly threadOutput: string;
  readonly threadComplete: boolean;
}

export type OrchestratorAction =
  | { readonly action: "wait"; readonly reason: string }
  | { readonly action: "advance-to-implementing"; readonly plan: readonly string[] }
  | { readonly action: "advance-to-in-review"; readonly prUrl: string }
  | { readonly action: "fail"; readonly reason: string };

/**
 * Decide the next orchestration action based on run state and thread output.
 *
 * Pure function: no side effects. The caller in Layers/SymphonyService.ts
 * performs the actual DB writes, Linear updates, and thread dispatches.
 *
 * TODO(phase-4): Wire this into reconcileRunWithThread once Phase 4 updates
 * the phase prompts to emit SYMPHONY_PLAN_BEGIN/SYMPHONY_PR_URL markers.
 * Currently, reconcileRunWithThread calls phaseOutput.ts helpers directly.
 */
export function decideNextAction(input: OrchestratorInput): OrchestratorAction {
  if (!input.threadComplete) {
    return { action: "wait", reason: "turn_streaming" };
  }

  if (input.run.lifecyclePhase === "planning") {
    const plan = parsePlanFromOutput(input.threadOutput);
    if (plan === null) {
      return { action: "fail", reason: "no_parseable_plan" };
    }
    return { action: "advance-to-implementing", plan };
  }

  if (input.run.lifecyclePhase === "implementing") {
    const prUrl = parsePRUrlFromOutput(input.threadOutput);
    if (prUrl === null) {
      return { action: "fail", reason: "no_pr_url" };
    }
    return { action: "advance-to-in-review", prUrl };
  }

  return { action: "wait", reason: "unrecognized_status" };
}
