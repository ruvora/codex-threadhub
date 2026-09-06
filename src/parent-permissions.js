import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

const fail = reason => Object.assign(new Error(`Cannot inherit parent permissions: ${reason}`), { code: 'PARENT_PERMISSIONS_UNAVAILABLE' });

// Read only the host-returned path for the exact requesting thread. Never resume
// the parent or accept a permission grant supplied in a tool argument/prompt.
export async function readParentPermissions(control, origin) {
  if (!origin?.threadId) return null; // Legacy CLI calls retain explicit contracts.
  const result = await control.inspectAgent(origin.threadId);
  const thread = result?.thread ?? result;
  if (thread?.id !== origin.threadId || !isAbsolute(thread.path ?? '')) throw fail('missing native thread path');
  let file;
  try {
    file = await open(thread.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw fail('unsupported native file');
    return permissionsFromRollout(await file.readFile('utf8'), origin);
  } finally { await file?.close(); }
}

export function permissionsFromRollout(text, origin) {
  let identity, context;
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'session_meta') identity = row.payload?.id ?? row.payload?.session_id;
    if (row.type === 'turn_context' && (!origin.turnId || row.payload?.turn_id === origin.turnId)) context = row.payload;
  }
  if (identity !== origin.threadId || !context) throw fail('no matching native turn context');
  const policy = context.sandbox_policy;
  const sandbox = policy?.type;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw fail('unsupported sandbox policy');
  const approvalPolicy = context.approval_policy;
  if (!['never', 'on-request', 'on-failure', 'untrusted'].includes(approvalPolicy)) throw fail('unsupported approval policy');
  return { sandbox, approvalPolicy, networkAccess: sandbox === 'danger-full-access' || policy.network_access === true,
    threadId: origin.threadId, turnId: context.turn_id, source: 'native_turn_context' };
}

export function inheritPermissions(task, permissions) {
  if (!permissions) return task;
  const executionCapabilities = task.executionCapabilities?.filter(value => value !== 'external-network');
  if (executionCapabilities && permissions.networkAccess) executionCapabilities.push('external-network');
  return { ...task, sandbox: permissions.sandbox, networkAccess: permissions.networkAccess,
    approvalPolicy: permissions.approvalPolicy, parentPermissions: permissions,
    ...(executionCapabilities ? { executionCapabilities } : {}) };
}

export function permissionRunOptions(permissions, cwd) {
  if (!permissions) return {};
  return { approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandbox === 'danger-full-access'
    ? { type: 'dangerFullAccess' }
    : permissions.sandbox === 'read-only' ? { type: 'readOnly' }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: permissions.networkAccess,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
}
