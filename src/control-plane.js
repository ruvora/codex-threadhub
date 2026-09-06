import { assertOutputSchema } from "./output-schema.js";
import { finalTurnOutput } from "./turn-output.js";
import { restoreNativeEvidence } from "./native-evidence.js";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const DEFAULT_MANAGED_THREAD_CONFIG = {
  plugins: {
    [process.env.CODEX_CONTROL_PLUGIN_ID ?? "codex-agent-control-plane@personal"]: { enabled: false },
  },
};

function terminalTurnFromRead(result, turnId) {
  const thread = result?.thread ?? result;
  const turns = thread?.turns ?? result?.turns ?? [];
  const turn = turns.find((entry) => entry?.id === turnId);
  const status = turn?.status?.type ?? turn?.status;
  return TERMINAL_TURN_STATUSES.has(status) ? { ...turn, status } : null;
}

function recoveredOutput(turn) {
  return finalTurnOutput(turn);
}

export function mergeTurnItems(...groups) {
  const merged = [];
  const positions = new Map();
  for (const item of groups.flat()) {
    if (!item) continue;
    const identity = item.id ?? `${item.type ?? item.kind ?? "item"}:${JSON.stringify(item)}`;
    if (positions.has(identity)) {
      const index = positions.get(identity);
      const previous = merged[index];
      merged[index] = { ...previous, ...item };
      // Persisted reads may omit command output that was present on the live
      // completion receipt. Null means unavailable, not an observed empty log.
      for (const key of ["aggregatedOutput", "stdout", "stderr"]) {
        if (item[key] == null && previous[key] != null) merged[index][key] = previous[key];
      }
    } else {
      positions.set(identity, merged.length);
      merged.push(item);
    }
  }
  return merged;
}

export class CodexControlPlane {
  constructor(client, options = {}) {
    this.client = client;
    this.resumeFlights = new Map();
    this.activeTaskStreams = new Map();
    this.resumeRetryDelaysMs = options.resumeRetryDelaysMs ?? [100, 300, 750];
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.managedThreadConfig = options.managedThreadConfig ?? DEFAULT_MANAGED_THREAD_CONFIG;
  }

  async connect() {
    await this.client.connect();
  }

  async listAgents(options = {}) {
    const result = await this.client.request("thread/list", {
      limit: options.limit ?? 20,
      sortKey: options.sortKey ?? "recency_at",
      sortDirection: options.sortDirection ?? "desc",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.archived !== undefined ? { archived: options.archived } : {}),
      sourceKinds: options.sourceKinds ?? [
        "cli",
        "vscode",
        "appServer",
        "subAgent",
        "subAgentReview",
        "subAgentThreadSpawn",
        "subAgentOther",
      ],
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });

    return {
      agents: (result.data ?? []).map((thread) => this.#toAgent(thread)),
      nextCursor: result.nextCursor ?? null,
    };
  }

  async nameAgent(threadId, name) {
    if (!name?.trim()) throw new TypeError("Agent name must not be empty");
    await this.client.request("thread/name/set", { threadId, name: name.trim() });
    return { threadId, name: name.trim() };
  }

  async archiveAgent(threadId) {
    const result = await this.client.request("thread/archive", { threadId });
    return result.thread ?? result;
  }

  async unarchiveAgent(threadId) {
    const result = await this.client.request("thread/unarchive", { threadId });
    return result.thread ?? result;
  }

  async spawnAgent(options = {}) {
    const result = await this.client.request("thread/start", {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "read-only",
      serviceName: "codex_control_plane",
      config: options.config ?? this.managedThreadConfig,
      ...(options.model ? { model: options.model } : {}),
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    });
    return this.#toAgent(result.thread, result.instructionSources);
  }

  async resumeAgent(threadId, options = {}) {
    if (this.resumeFlights.has(threadId)) return this.resumeFlights.get(threadId);
    const flight = this.#resumeWithOwnershipRetry(threadId, options).finally(() => {
      if (this.resumeFlights.get(threadId) === flight) this.resumeFlights.delete(threadId);
    });
    this.resumeFlights.set(threadId, flight);
    return flight;
  }

  async #resumeWithOwnershipRetry(threadId, options) {
    const params = {
      threadId,
      ...(this.client.experimentalApiEnabled === false ? {} : { excludeTurns: true }),
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      config: options.config ?? this.managedThreadConfig,
    };
    let ownershipError;
    for (let attempt = 0; attempt <= this.resumeRetryDelaysMs.length; attempt += 1) {
      try {
        const result = await this.client.request("thread/resume", params);
        return this.#toAgent(result.thread, result.instructionSources);
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        ownershipError = error;
        if (attempt === this.resumeRetryDelaysMs.length) break;
        await this.delay(this.resumeRetryDelaysMs[attempt]);
      }
    }
    const error = new Error(`Codex thread ${threadId} is owned by another active App Server writer; close or release it there, then retry`);
    error.name = "ThreadOwnershipError";
    error.code = "THREAD_ACTIVE_WRITER";
    error.method = "thread/resume";
    error.cause = ownershipError;
    error.retryable = true;
    error.threadId = threadId;
    throw error;
  }

  async forkAgent(threadId, options = {}) {
    const result = await this.client.request("thread/fork", {
      threadId,
      ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      config: options.config ?? this.managedThreadConfig,
    });
    return this.#toAgent(result.thread, result.instructionSources);
  }

  async inspectAgent(threadId, options = {}) {
    return this.client.request("thread/read", {
      threadId,
      includeTurns: options.includeTurns ?? false,
    }, options.timeoutMs);
  }

  async runTask(threadId, prompt, options = {}) {
    if (options.outputSchema !== undefined) assertOutputSchema(options.outputSchema);
    if (!prompt?.trim()) throw new TypeError("Task prompt must not be empty");

    let output = "";
    let turnId = null;
    const pendingDeltas = [];
    const streamToken = Symbol(threadId);
    const activeStreams = this.activeTaskStreams.get(threadId) ?? new Set();
    activeStreams.add(streamToken);
    this.activeTaskStreams.set(threadId, activeStreams);
    const observedItems = [];
    const commandStreams = new Map();
    const onCommandDelta = (params) => {
      if (params?.threadId !== threadId || !params.turnId || !params.itemId || typeof params.delta !== "string") return;
      const key = JSON.stringify([params.turnId, params.itemId]);
      const entry = commandStreams.get(key) ?? { turnId: params.turnId, id: params.itemId, text: '', truncated: false };
      const available = Math.max(0, 1_000_000 - entry.text.length);
      entry.text += params.delta.slice(0, available);
      entry.truncated ||= params.delta.length > available;
      commandStreams.set(key, entry);
    };
    const streamEvidence = () => [...commandStreams.values()].filter(entry => entry.turnId === turnId)
      .map(entry => ({ id: entry.id, type: "commandExecution", streamedOutput: entry.text,
        streamedOutputTruncated: entry.truncated, streamedOutputCompleteness: "not_guaranteed" }));
    const onDelta = (params) => {
      if (params.threadId !== threadId || typeof params.delta !== "string") return;
      const deltaTurnId = params.turnId ?? params.turn?.id ?? null;
      if (!turnId) {
        pendingDeltas.push({ turnId: deltaTurnId, delta: params.delta });
        return;
      }
      if (deltaTurnId === turnId || (!deltaTurnId && activeStreams.size === 1)) output += params.delta;
    };
    const onItemCompleted = (params) => {
      if (params?.threadId === threadId && params.item) observedItems.push({ turnId: params.turnId ?? null, item: params.item });
    };
    this.client.on("item/agentMessage/delta", onDelta);
    this.client.on("item/completed", onItemCompleted);
    this.client.on("item/commandExecution/outputDelta", onCommandDelta);

    try {
      const result = await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
        ...(options.additionalContext ? { additionalContext: options.additionalContext } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(options.sandboxPolicy && this.client.experimentalApiEnabled !== false
          ? { sandboxPolicy: options.sandboxPolicy }
          : {}),
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      turnId = result.turn.id;
      for (const delta of pendingDeltas) {
        if (delta.turnId === turnId || (!delta.turnId && activeStreams.size === 1)) output += delta.delta;
      }
      options.onStarted?.({ threadId, turnId, turn: result.turn });
      let completion;
      const timeoutMs = options.timeoutMs ?? this.client.turnTimeoutMs ?? 30 * 60_000;
      const deadline = Date.now() + timeoutMs;
      const recoveryProbeMs = Math.min(options.recoveryProbeMs ?? 15_000, timeoutMs);
      while (!completion) {
        try {
          completion = await this.client.waitForNotification(
            (message) => {
              if (["turn/completed", "turn/failed", "turn/interrupted"].includes(message.method)) {
                return message.params?.threadId === threadId && message.params?.turn?.id === turnId;
              }
              return message.method === "error" && message.params?.threadId === threadId && message.params?.turnId === turnId;
            },
            Math.max(1, Math.min(recoveryProbeMs, deadline - Date.now())),
          );
        } catch (error) {
          if (!/Timed out waiting for app-server notification/i.test(String(error?.message ?? ""))) throw error;
          const recoveredRead = await this.inspectAgent(threadId, { includeTurns: true });
          const recoveredTurn = terminalTurnFromRead(recoveredRead, turnId);
          if (recoveredTurn) {
            const liveItems = observedItems.filter((entry) => entry.turnId === turnId
              || (!entry.turnId && activeStreams.size === 1)).map((entry) => entry.item);
            const native = await restoreNativeEvidence({ path: recoveredRead.thread?.path, threadId, turnId,
              items: mergeTurnItems(streamEvidence(), liveItems, recoveredTurn.items ?? []) });
            const executionItems = native.items;
            const recovered = {
              threadId,
              turnId,
              output: recoveredOutput(recoveredTurn) || output,
              turn: { ...recoveredTurn, items: executionItems },
              executionItems,
              nativeEvidence: native.nativeEvidence,
              workerToolReceipts: native.workerToolReceipts,
              completionMethod: "thread/read-recovery",
              recoveredFromRead: true,
              evidenceComplete: true,
            };
            options.onCompleted?.(recovered);
            return recovered;
          }
          if (Date.now() >= deadline) throw error;
        }
      }
      if (completion.method === "error") {
        throw new Error(completion.params?.error?.message ?? completion.params?.error ?? "Codex App Server turn failed");
      }
      const notificationStatus = completion.method.slice("turn/".length);
      const turn = {
        ...(completion.params.turn ?? {}),
        status: completion.params.turn?.status ?? notificationStatus,
        ...(completion.params.error && !completion.params.turn?.error ? { error: completion.params.error } : {}),
      };
      const liveItems = observedItems.filter((entry) => entry.turnId === turnId
        || (!entry.turnId && activeStreams.size === 1)).map((entry) => entry.item);
      let hydratedTurn = null;
      let hydratedRead = null;
      let hydrationError = null;
      try {
        hydratedRead = await this.inspectAgent(threadId, {
          includeTurns: true,
          timeoutMs: Math.max(1, Math.min(options.evidenceHydrationTimeoutMs ?? 5_000, deadline - Date.now())),
        });
        hydratedTurn = terminalTurnFromRead(hydratedRead, turnId);
      } catch (error) {
        hydrationError = error;
      }
      const native = await restoreNativeEvidence({ path: hydratedRead?.thread?.path, threadId, turnId,
        items: mergeTurnItems(streamEvidence(), liveItems, turn.items ?? [], hydratedTurn?.items ?? []) });
      const executionItems = native.items;
      const finalTurn = hydratedTurn ? {
        ...turn,
        ...hydratedTurn,
        status: hydratedTurn.status ?? turn.status,
        items: executionItems,
        ...(turn.error && !hydratedTurn.error ? { error: turn.error } : {}),
      } : { ...turn, items: executionItems };
      const completed = {
        threadId,
        turnId,
        output: recoveredOutput(hydratedTurn) || output,
        turn: finalTurn,
        executionItems,
        nativeEvidence: native.nativeEvidence,
        workerToolReceipts: native.workerToolReceipts,
        completionMethod: hydratedTurn ? `${completion.method}+thread/read` : completion.method,
        evidenceComplete: Boolean(hydratedTurn),
        ...(hydrationError ? { hydrationError: hydrationError.message } : {}),
      };
      options.onCompleted?.(completed);
      return completed;
    } finally {
      this.client.off("item/agentMessage/delta", onDelta);
      this.client.off("item/completed", onItemCompleted);
      this.client.off("item/commandExecution/outputDelta", onCommandDelta);
      activeStreams.delete(streamToken);
      if (!activeStreams.size && this.activeTaskStreams.get(threadId) === activeStreams) this.activeTaskStreams.delete(threadId);
    }
  }

  async interruptTask(threadId, turnId) {
    return this.client.request("turn/interrupt", { threadId, turnId });
  }

  #toAgent(thread, instructionSources = []) {
    return {
      id: thread.id,
      sessionId: thread.sessionId ?? thread.id,
      name: thread.name ?? null,
      cwd: thread.cwd ?? null,
      model: thread.model ?? null,
      provider: "codex",
      status: thread.status?.type ?? thread.status ?? "unknown",
      source: thread.source ?? thread.sourceKind ?? null,
      ephemeral: thread.ephemeral ?? false,
      forkedFromId: thread.forkedFromId ?? null,
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
      archivedAt: thread.archivedAt ?? null,
      instructionSources,
    };
  }
}

export function isActiveWriterError(error) {
  return error?.method === "thread/resume"
    && /already has an active writer|active elsewhere|owned by another.*writer/i.test(String(error?.message ?? ""));
}
