import { commandObservation } from "./command-evidence.js";

// Current task/dependency evidence only: never search unrelated agent memories.
export function executionReports(registry, taskId) {
  return registry.listTurnDispatches({ parentTaskId: taskId, purpose: "execution", limit: 1000000 })
    .filter(dispatch => dispatch.evidence?.result)
    .sort((a, b) => a.revision - b.revision)
    .map(dispatch => ({ dispatchId: dispatch.id, revision: dispatch.revision,
      threadId: dispatch.threadId, turnId: dispatch.turnId, status: dispatch.status,
      completedAt: dispatch.terminalAt, output: dispatch.evidence.result.output ?? null,
      nativeEvidence: dispatch.evidence.result.nativeEvidence ?? { status: 'unavailable' },
      workerToolReceipts: dispatch.evidence.result.workerToolReceipts ?? [],
      commandObservations: (dispatch.evidence.result.executionItems ?? dispatch.evidence.result.turn?.items ?? [])
        .filter(item => /command/i.test(item.type ?? item.kind ?? "")).map(commandObservation),
      executionItems: (dispatch.evidence.result.executionItems ?? dispatch.evidence.result.turn?.items ?? [])
        .filter(item => /command/i.test(item.type ?? item.kind ?? "")) }));
}

export function dependencyEvidence(registry, task) {
  return (task.dependencies ?? []).map(dependency => {
    const id = typeof dependency === "string" ? dependency : dependency.taskId;
    const parent = registry.getTask(id);
    if (!parent) return { taskId: id, status: "missing", output: null };
    return { taskId: parent.id, title: parent.metadata?.title ?? parent.prompt.slice(0, 80),
      agentId: parent.agentId, status: parent.status, completedAt: parent.completedAt,
      output: parent.output, reports: executionReports(registry, parent.id),
      validation: parent.metadata?.validation ?? null,
      artifact: parent.metadata?.integration?.artifact ?? null,
      integration: parent.metadata?.integration ?? null };
  });
}
