import { workStatus } from "./work-status.js";
import { publicWorkName } from "./agent-names.js";

export function workPanelSnapshot(registry, runId) {
  const run = registry.getRun(runId);
  if (!run) return null;
  const status = workStatus(registry, run);
  // A progress token only exposes navigation and status, never failure logs.
  const work = Object.fromEntries(['runId', 'name', 'status', 'master', 'progress', 'needsAttention'].map(key => [key, status[key]]));
  return { work, tasks: registry.listTasks({ runId, limit: 1000000 }).map(task => ({
    id: task.id,
    name: publicWorkName(task.metadata?.title ?? "작업"),
    status: task.status,
    dependsOn: (task.dependencies ?? []).map(dep => typeof dep === 'string' ? dep : dep.taskId ?? dep.dependsOnTaskId).filter(Boolean),
    threadId: task.agentId ?? null,
  })) };
}
