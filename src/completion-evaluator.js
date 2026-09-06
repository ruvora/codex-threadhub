import { createHash } from "node:crypto";

import { assessTaskResult } from "./failure-classifier.js";
import { isTestCommand, commandSucceeded } from "./command-evidence.js";

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function itemType(item) {
  return String(item?.type ?? item?.kind ?? "").replaceAll("_", "").toLowerCase();
}

function commandItems(result = {}) {
  const values = [...(result.turn?.items ?? []), ...(result.executionItems ?? [])];
  const seen = new Set();
  return values.filter((item) => {
    const identity = item?.id ?? item;
    if (seen.has(identity)) return false;
    seen.add(identity);
    const type = itemType(item);
    return type.includes("commandexecution") || type.includes("command");
  });
}

function structuredOutputs(output) {
  if (typeof output === "object" && output) return output.outputs ?? output;
  if (typeof output !== "string") return {};
  const value = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!value.startsWith("{") || !value.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed?.outputs ?? parsed ?? {};
  } catch {
    return {};
  }
}

function reject(details = {}) {
  return {
    decision: details.decision ?? "reject",
    category: details.category ?? "product",
    cause: details.cause ?? "Completion evidence was not satisfied",
    satisfiedEvidence: details.satisfiedEvidence ?? [],
    missingEvidence: details.missingEvidence ?? [],
    conflictingEvidence: details.conflictingEvidence ?? [],
    retryable: details.retryable ?? false,
    nextAction: details.nextAction ?? "rework",
  };
}

export function completionFailure(verdict) {
  const value = typeof verdict?.cause === "object" && verdict.cause
    ? verdict.cause
    : {};
  const message = value.message ?? value.cause ?? String(verdict?.cause ?? "Completion evidence was not satisfied");
  return {
    ...value,
    type: value.type ?? (verdict?.category === "coordination" ? "coordination" : "worker"),
    category: value.category ?? verdict?.category ?? "product",
    stage: value.stage ?? "completion",
    cause: message,
    message,
    retryable: Boolean(verdict?.retryable ?? value.retryable),
    nextAction: verdict?.nextAction ?? value.nextAction ?? "rework",
    evidenceFingerprint: verdict?.evidenceFingerprint ?? null,
    missingEvidence: verdict?.missingEvidence ?? [],
    conflictingEvidence: verdict?.conflictingEvidence ?? [],
    at: value.at ?? new Date().toISOString(),
  };
}

/**
 * Produce the sole evidence-based Task completion verdict.
 * `strictEvidence=false` exists only for legacy/injected controls that cannot expose
 * App Server hydration metadata; the real CodexControlPlane always supplies it.
 */
export function evaluateTaskCompletion(options = {}) {
  const result = options.result ?? {};
  const contract = options.contract ?? {};
  const acceptanceCriteria = options.acceptanceCriteria ?? [];
  const validation = options.validation ?? null;
  const artifact = options.artifact ?? options.integration?.artifact ?? null;
  const workspaceEvidence = options.workspaceEvidence ?? null;
  const postcondition = options.postconditionEvidence ?? null;
  const strictEvidence = options.strictEvidence ?? true;
  const satisfiedEvidence = [];
  const missingEvidence = [];
  const conflictingEvidence = [];

  const commandReviews = [];
  const executionFailure = assessTaskResult(result, acceptanceCriteria.length && [undefined, "none"].includes(contract.integrationStrategy) ? { commandReviews } : {});
  if (executionFailure) {
    return finalize(reject({ category: executionFailure.category, cause: executionFailure, retryable: executionFailure.retryable, nextAction: executionFailure.nextAction }), contract, result, validation, artifact, postcondition);
  }
  satisfiedEvidence.push("terminal-turn");

  if (strictEvidence && result.evidenceComplete !== true) {
    const replaySafe = contract.mutatesWorkspace === false && [undefined, null, "none"].includes(contract.sideEffectPolicy);
    missingEvidence.push("complete-turn");
    return finalize(reject({
      decision: "attention", category: "coordination",
      cause: result.hydrationError ?? "Terminal Turn evidence could not be hydrated",
      satisfiedEvidence, missingEvidence, retryable: replaySafe, nextAction: replaySafe ? "reconcile_dispatch" : "inspect_side_effects",
    }), contract, result, validation, artifact, postcondition);
  }
  if (result.evidenceComplete === true) satisfiedEvidence.push("complete-turn");

  const commands = commandItems(result);
  // Execution intent is structured; a review mentioning tests is not a test run.
  if (contract.taskKind === "test" && strictEvidence && !commands.some(item => isTestCommand(item) && commandSucceeded(item))) {
    missingEvidence.push(commands.some(isTestCommand) ? "test-exit-evidence" : "required-test-command");
    return finalize(reject({ decision: "attention", category: "coordination",
      cause: "Test execution could not be verified from native command receipts",
      satisfiedEvidence, missingEvidence, retryable: false, nextAction: "inspect_execution_evidence",
    }), contract, result, validation, artifact, postcondition);
  } else if (commands.length) {
    satisfiedEvidence.push("command-ledger");
  }

  if (options.phase === "execution") {
    if (missingEvidence.length || conflictingEvidence.length) {
      return finalize(reject({
        category: "product",
        cause: "Required execution evidence is missing",
        satisfiedEvidence, missingEvidence, conflictingEvidence,
        retryable: true, nextAction: "rework",
      }), contract, result, validation, artifact, postcondition);
    }
    return finalize({
      decision: "accept", category: "none", cause: null,
      satisfiedEvidence, missingEvidence, conflictingEvidence,
      retryable: false, nextAction: "continue_completion",
    }, contract, result, validation, artifact, postcondition);
  }

  if (commandReviews.length) {
    const unresolved = commandReviews.filter(command => {
      const matches = (validation?.commandAssessments ?? []).filter(review => review.itemId === command.itemId);
      return matches.length !== 1 || matches[0].exitCode !== command.exitCode
        || !["expected_nonzero", "optional_unavailable"].includes(matches[0].disposition)
        || !matches[0].evidence?.length;
    });
    if (unresolved.length) return finalize(reject({
      decision: "attention", category: "validation", cause: "Nonzero command outcomes require evidence-backed acceptance review",
      missingEvidence: unresolved.map(command => `command-review:${command.itemId}`),
      retryable: false, nextAction: "inspect_execution_evidence",
    }), contract, result, validation, artifact, postcondition);
    satisfiedEvidence.push("reviewed-nonzero-commands");
  }

  const output = typeof result.output === "string" ? result.output.trim() : result.output;
  const outputClaims = structuredOutputs(result.output);
  for (const declared of contract.outputs ?? []) {
    if (declared === "report") {
      if (output && (typeof output !== "object" || Object.keys(output).length)) satisfiedEvidence.push("output:report");
      else missingEvidence.push("output:report");
    } else if (["workspace-change", "patch", "commit"].includes(declared)) {
      const changed = artifact?.changed === true || workspaceEvidence?.changed === true;
      if (changed) satisfiedEvidence.push(`output:${declared}`);
      else if (strictEvidence || artifact || workspaceEvidence?.available === true) missingEvidence.push(`output:${declared}`);
    } else {
      const claimed = outputClaims?.[declared];
      const reportValue = typeof claimed === "string" ? claimed.trim().length > 0
        : claimed && !Array.isArray(claimed) && typeof claimed === "object" && Object.keys(claimed).length > 0;
      const externalArtifact = /(?:^|[-_.])(artifact|file|patch|commit)(?:$|[-_.])/i.test(declared);
      const materialized = options.outputEvidence?.some?.((entry) => entry?.name === declared && entry?.materialized === true
        && entry?.verified === true && entry?.contentHash && entry?.source)
        || (!externalArtifact && reportValue);
      if (materialized) satisfiedEvidence.push(`output:${declared}`);
      else if (strictEvidence) missingEvidence.push(`output:${declared}`);
    }
  }

  if (contract.mutatesWorkspace === false && workspaceEvidence?.changed === true) {
    if (workspaceEvidence.attribution === "shared_unattributed") {
      return finalize(reject({ decision: "attention", category: "coordination", cause: "Shared workspace changed; writer attribution requires inspection",
        satisfiedEvidence, conflictingEvidence: ["unattributed-workspace-mutation"], retryable: false, nextAction: "inspect_side_effects" }), contract, result, validation, artifact, postcondition);
    }
    conflictingEvidence.push("unexpected-workspace-mutation");
  }

  if (acceptanceCriteria.length) {
    if (!validation) missingEvidence.push("validation");
    else if (!["accept", "accept_with_warnings"].includes(validation.decision)) conflictingEvidence.push("validation");
    else satisfiedEvidence.push("validation");
  }

  if (contract.integrationStrategy && contract.integrationStrategy !== "none") {
    if (options.integration?.status === "integrated" && artifact?.changed === true) satisfiedEvidence.push("integration");
    else if (strictEvidence || options.integration || artifact) missingEvidence.push("integration");
  }

  if (postcondition?.required) {
    if (postcondition.passed === true) satisfiedEvidence.push("destination-postcondition");
    else conflictingEvidence.push("destination-postcondition");
  }

  if (missingEvidence.length || conflictingEvidence.length) {
    return finalize(reject({
      category: conflictingEvidence.includes("validation") ? (validation?.failureKind === "product" ? "product" : "validation") : "product",
      cause: postcondition?.passed === false ? postcondition.summary ?? "Destination postcondition failed" : "Required completion evidence is missing or contradictory",
      satisfiedEvidence, missingEvidence, conflictingEvidence,
      retryable: true, nextAction: "rework",
    }), contract, result, validation, artifact, postcondition);
  }

  return finalize({
    decision: commandReviews.length || validation?.decision === "accept_with_warnings" ? "accept_with_warnings" : "accept",
    category: "none",
    cause: null,
    satisfiedEvidence,
    missingEvidence,
    conflictingEvidence,
    retryable: false,
    nextAction: "none",
  }, contract, result, validation, artifact, postcondition);
}

function finalize(verdict, contract, result, validation, artifact, postcondition) {
  const evidencePayload = {
    contractFingerprint: contract?.fingerprint ?? null,
    turnId: result?.turnId ?? result?.turn?.id ?? null,
    turnStatus: result?.turn?.status?.type ?? result?.turn?.status ?? result?.status ?? null,
    evidenceComplete: result?.evidenceComplete ?? null,
    executionItems: commandItems(result).map((item) => ({ id: item.id ?? null, type: item.type ?? item.kind ?? null, command: item.command ?? item.cmd ?? null, exitCode: item.exitCode ?? item.exit_code ?? item.result?.exitCode ?? null, status: item.status ?? null })),
    outputFingerprint: fingerprint(result?.output ?? null),
    validation,
    artifact,
    postcondition,
  };
  return {
    ...verdict,
    version: 1,
    contractFingerprint: contract?.fingerprint ?? null,
    evidenceFingerprint: fingerprint(evidencePayload),
    evaluatedAt: new Date().toISOString(),
  };
}

export function evaluateSynthesisConsistency(runStatus, text) {
  const value = String(text ?? "").toLowerCase();
  const claimsSuccess = /(?:overall\s+(?:verdict|status)\s*[:=-]?\s*(?:success|completed)|전체\s*(?:결과|판정)?\s*[:=-]?\s*(?:성공|완료)|모든\s+(?:작업|태스크).*(?:성공|완료))/.test(value);
  const claimsFailure = /(?:overall\s+(?:verdict|status)\s*[:=-]?\s*(?:failed|failure|cancelled)|전체\s*(?:결과|판정)?\s*[:=-]?\s*(?:실패|취소))/.test(value);
  const inconsistent = (["failed", "cancelled"].includes(runStatus) && claimsSuccess)
    || (runStatus === "completed" && claimsFailure);
  return {
    consistent: !inconsistent,
    runStatus,
    claimsSuccess,
    claimsFailure,
    summary: inconsistent ? `Run ${runStatus}: Master synthesis contradicted the durable Run verdict.` : null,
  };
}
