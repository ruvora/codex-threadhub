import { isTestCommand, supersededTestFailure, commandText, commandExitCode, isEmptyFileSearch } from "./command-evidence.js";

export function classifyFailure(error, stage = "execution") {
  const message = String(error?.message ?? error ?? "Unknown failure");
  let code = error?.code ?? null;
  const value = `${code ?? ""} ${message}`.toLowerCase();
  let type = stage === "validation" ? "validation" : "worker";
  let retryable = Boolean(error?.retryable);

  if (/output_schema_invalid|invalid_json_schema|invalid schema for response_format/.test(value)) {
    type = "configuration";
    code = "OUTPUT_SCHEMA_INVALID";
    retryable = false;
  } else if (/^(?:CONTEXT_(?:SUPERSEDE|AUTHORITY|CLAIM)|CONTEXT_SNAPSHOT_INVALID|PRODUCT_CONTRACT_)/.test(String(code ?? ""))) {
    type = "configuration";
    retryable = false;
  } else if (/unexpected status 404 not found.*(?:backend-api\/codex\/responses|codex\/responses)/.test(value)) {
    type = "infrastructure";
    code ??= "APP_SERVER_UPSTREAM_404";
    retryable = true;
  } else if (/\breconnecting(?:\.\.\.)?\s*\d+\/\d+/.test(value)) {
    type = "infrastructure";
    code ??= "APP_SERVER_RECONNECT_INTERRUPTED";
    retryable = true;
  } else if (/execution_contract|execution contract|read-only|read only|insufficient sandbox|cannot (?:write|modify|edit)|missing required (?:tool|capability)/.test(value)) {
    type = "configuration";
    retryable = false;
  } else if (/timed? out|timeout/.test(value)) {
    type = "timeout";
    retryable = true;
  } else if (/thread_active_writer|active writer|already has an active writer|lease|fenc/.test(value)) {
    type = "coordination";
    retryable = true;
  } else if (/eperm|environment|runtime unavailable|node: command not found/.test(value)) {
    type = "environment";
    retryable = false;
  } else if (/econn|socket|app-server exited|not connected|spawn|enoent/.test(value)) {
    type = "infrastructure";
    retryable = true;
  } else if (/approval|declin|denied|permission/.test(value)) {
    type = "approval";
    retryable = false;
  } else if (/worktree|git /.test(value)) {
    type = "workspace";
    retryable = false;
  } else if (/routing|required capability|required tool|no candidate/.test(value)) {
    type = "routing";
    retryable = false;
  } else if (/interrupted|cancelled|canceled/.test(value)) {
    type = "interrupted";
    retryable = false;
  } else if (/\b(?:test|tests|assertion|assertions)\b.*\b(?:fail|failed|failure|failures)\b|\b(?:fail|failed|failure|failures)\b.*\b(?:test|tests|assertion|assertions)\b/.test(value)) {
    type = "test";
    retryable = true;
  } else if (/\b(?:exit code|exit status|exited with)\b/.test(value)) {
    type = "command";
    retryable = true;
  } else if (stage === "validation") {
    retryable = true;
  }

  const category = type === "approval" ? "policy"
    : ["configuration", "workspace", "routing"].includes(type) ? "configuration"
    : ["environment", "infrastructure"].includes(type) ? "environment"
    : ["coordination", "timeout", "interrupted"].includes(type) ? "coordination"
    : type === "validation" ? "validation"
    : "product";
  const nextAction = error?.nextAction ?? (["infrastructure", "coordination", "timeout"].includes(type)
    ? "retry"
    : ["validation", "test", "command", "worker"].includes(type)
      ? "rework"
      : type === "configuration" ? "repair_contract" : "manual_intervention");
  return { type, category, stage, cause: message, retryable, nextAction, code, message, at: new Date().toISOString() };
}

function itemType(item) {
  return String(item?.type ?? item?.kind ?? "").replaceAll("_", "").toLowerCase();
}

function commandOutput(item) {
  const values = [
    item?.aggregatedOutput, item?.output, item?.stderr, item?.stdout,
    item?.result?.aggregatedOutput, item?.result?.output, item?.result?.stderr, item?.result?.stdout,
  ];
  return values.filter((value) => typeof value === "string" && value.trim()).join("\n");
}

function structuredFailure(output) {
  const value = String(output ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.success === false || parsed?.failed === true || ["failed", "failure", "error"].includes(String(parsed?.status ?? "").toLowerCase())) {
      return parsed?.error?.message ?? parsed?.error ?? parsed?.reason ?? parsed?.summary ?? "Task explicitly reported failure";
    }
  } catch {
    return null;
  }
  return null;
}

/** Return a classified failure when a terminal Codex turn did not actually succeed. */
export function assessTaskResult(result = {}, options = {}) {
  const turn = result.turn ?? {};
  const status = turn.status?.type ?? turn.status ?? result.status ?? "completed";
  if (status !== "completed") {
    return classifyFailure(turn.error?.message ?? turn.error ?? result.error ?? `Agent turn ended with status: ${status}`, "execution");
  }
  if (turn.error || result.error || turn.success === false || result.success === false || turn.failed === true || result.failed === true) {
    return classifyFailure(turn.error?.message ?? turn.error ?? result.error ?? "Task explicitly reported failure", "execution");
  }

  const items = [...(turn.items ?? []), ...(result.executionItems ?? [])].filter((item,index,all) =>
    !item.id || all.findIndex(other => other.id === item.id) === index);
  const seen = new Set();
  let successfulTestCommand = false;
  for (const [index, item] of items.entries()) {
    const identity = item?.id ?? item;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const type = itemType(item);
    if (!type.includes("commandexecution") && !type.includes("command")) continue;
    const exitCode = commandExitCode(item);
    const itemStatus = String(item?.status?.type ?? item?.status ?? "").toLowerCase();
    const command = commandText(item);
    if ((exitCode === null || exitCode === 0) && !["failed", "error"].includes(itemStatus)) {
      if (exitCode === 0 && isTestCommand(command)) successfulTestCommand = true;
      continue;
    }
    const diagnostic = commandOutput(item);
    if (isEmptyFileSearch(item)) continue;
    if (supersededTestFailure(item, items.slice(index + 1))) continue;
    // Command arguments can contain words such as approval, timeout or lease as
    // search terms/file names. They are evidence, not runtime error diagnostics.
    const failure = classifyFailure(new Error(`Command exited with code ${exitCode ?? "unknown"}${diagnostic ? `\n${diagnostic}` : ""}`), "execution");
    failure.message = `${command || "Command"} exited with code ${exitCode ?? "unknown"}${diagnostic ? `\n${diagnostic}` : ""}`;
    if (!["configuration", "environment", "infrastructure", "coordination", "approval", "workspace"].includes(failure.type)) {
      failure.type = isTestCommand(command) ? "test" : "command";
      failure.category = "product";
      failure.retryable = true;
      failure.nextAction = "rework";
    }
    failure.command = command || null;
    failure.exitCode = exitCode;
    failure.cause = failure.message;
    // Only a separate acceptance review may interpret a diagnostic's nonzero
    // exit. Never defer test failures, authority failures or unknown exits.
    if (options.commandReviews && failure.type === "command" && item.id
      && Number.isInteger(exitCode) && exitCode !== 0) {
      options.commandReviews.push({ itemId: item.id, command, exitCode, failure });
      continue;
    }
    return failure;
  }

  const explicit = structuredFailure(result.output);
  if (explicit) return classifyFailure(explicit, "execution");
  const output = String(result.output ?? "");
  const exitMatch = successfulTestCommand ? null : output.match(/\b(?:exit code|exit status|exited with(?: code)?)\s*[:=]?\s*([1-9]\d*)\b/i);
  const failedTests = successfulTestCommand ? null
    : output.match(/(?:^|\n)\s*(?:#\s*)?(?:fail|failed|failures)\s*[:=]\s*([1-9]\d*)\s*(?:$|\n)/im)
      ?? output.match(/(?:^|\n)\s*([1-9]\d*)\s+tests?\s+failed(?:[.!]?\s*)?(?:$|\n)/im);
  if (exitMatch || failedTests) {
    const failure = classifyFailure(exitMatch ? `Command exited with code ${exitMatch[1]}` : `${failedTests[1]} tests failed`, "execution");
    if (!["configuration", "environment", "infrastructure", "coordination", "approval", "workspace"].includes(failure.type)) {
      failure.type = failedTests ? "test" : "command";
      failure.category = "product";
      failure.retryable = true;
      failure.nextAction = "rework";
    }
    failure.exitCode = exitMatch ? Number(exitMatch[1]) : null;
    failure.cause = failure.message;
    return failure;
  }
  return null;
}
