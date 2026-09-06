import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commandExitCode } from './command-evidence.js';

// Decode only literal shell words in the host's display string. Never execute
// it or split/reconstruct the script inside argv[2]: operators and quoting there
// are part of the command identity, including for multi-action commands.
function displayArgv(text) {
  if (typeof text !== 'string') return null;
  const words = [];
  let word = '', quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
    } else if (c === '\\') {
      const next = text[++i];
      if (next === undefined || next === '\n') return null;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\';
      word += next; started = true;
    } else if (quote && c === quote) {
      quote = null;
    } else if (!quote && (c === "'" || c === '"')) {
      quote = c; started = true;
    } else if (c === '$' || c === '`' || (!quote && /[;|&<>\n\r()*?~\[\]{}#]/.test(c))) {
      return null;
    } else if (!quote && /\s/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false;
    } else {
      word += c; started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

// Only the exact host-returned rollout, session, turn and already observed item.
// Never discover unrelated sessions or use worker-provided paths as authority.
export async function restoreNativeEvidence({ path, threadId, turnId, items }) {
  const unchanged = reason => ({ items, workerToolReceipts: [], nativeEvidence: { status: 'unavailable', reason } });
  if (!path || !isAbsolute(path)) return unchanged('no_native_path');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return unchanged('unsupported_native_file');
    const text = await file.readFile('utf8');
    return reconcileNativeEvidence(text, { threadId, turnId, items });
  } catch (error) {
    return unchanged(error.code ?? 'native_read_failed');
  } finally { await file?.close(); }
}

export function reconcileNativeEvidence(text, { threadId, turnId, items }) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* A concurrently written tail is not evidence. */ }
  }
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if ((meta?.id ?? meta?.session_id) !== threadId) return { items, workerToolReceipts: [], nativeEvidence: { status: 'unavailable', reason: 'session_mismatch' } };
  const native = new Map();
  const workerToolReceipts = [];
  for (const row of rows) {
    const p = row.payload;
    if (row.type === 'event_msg' && p?.type === 'item_completed'
      && p.thread_id === threadId && p.turn_id === turnId && p.item?.type === 'CommandExecution') {
      native.set(p.item.id, p.item);
    }
    if (row.type === 'response_item' && p?.type === 'custom_tool_call_output'
      && p.internal_chat_message_metadata_passthrough?.turn_id === turnId) {
      for (const block of Array.isArray(p.output) ? p.output : []) {
        if (typeof block.text !== 'string') continue;
        try {
          const receipt = JSON.parse(block.text);
          if (typeof receipt.chunk_id !== 'string' || typeof receipt.output !== 'string' || !Number.isInteger(receipt.exit_code)) continue;
          workerToolReceipts.push({ namespace: 'tool_chunk', chunkId: receipt.chunk_id,
            callId: p.call_id, exitCode: receipt.exit_code, output: receipt.output,
            source: 'native_rollout_tool_response', threadId, turnId });
        } catch { /* Non-receipt tool text remains untrusted prose. */ }
      }
    }
  }
  const conflicts = [];
  const reconciled = items.map(item => {
    const raw = native.get(item.id);
    if (!raw) return item;
    const rawCommand = Array.isArray(raw.command) ? raw.command.at(-1) : raw.command;
    // Identity is necessary, but a mismatched command/exit cannot fill a log.
    const pathValue = value => { try { return typeof value === 'string' && value.startsWith('file:') ? fileURLToPath(value) : value; } catch { return null; } };
    // The host's display command is shell-escaped for presentation. Compare its
    // structured action instead of interpreting/evaluating that display string.
    const action = item.commandActions?.length === 1 ? item.commandActions[0] : null;
    const structuredMatch = Array.isArray(raw.command) && raw.command.length === 3
      && /\/(?:ba|z)?sh$/.test(raw.command[0]) && ['-c','-lc'].includes(raw.command[1])
      && typeof action?.command === 'string' && action.command === rawCommand
      && typeof item.cwd === 'string' && pathValue(item.cwd) === pathValue(raw.cwd)
      && (item.processId == null || raw.process_id == null || String(item.processId) === String(raw.process_id));
    const decoded = displayArgv(item.command);
    const displayMatches = Array.isArray(raw.command) && decoded?.length === raw.command.length
      && decoded.every((word, index) => word === raw.command[index]);
    const locationMatches = (item.cwd == null && raw.cwd == null
      || typeof item.cwd === 'string' && pathValue(item.cwd) === pathValue(raw.cwd))
      && (item.processId == null || raw.process_id == null || String(item.processId) === String(raw.process_id));
    const commandMatches = displayMatches || structuredMatch || typeof rawCommand === 'string'
      && (item.command === rawCommand || (Array.isArray(raw.command) && typeof item.command === 'string'
        && [raw.command.join(' '), `${raw.command[0]} ${raw.command[1]} '${rawCommand}'`, `${raw.command[0]} ${raw.command[1]} "${rawCommand}"`].includes(item.command)));
    if (!locationMatches || !commandMatches || commandExitCode(item) !== raw.exit_code) {
      conflicts.push({ itemId: item.id, kind: 'identity_or_exit_conflict' }); return item;
    }
    const out = { ...item };
    for (const [field, source] of [['aggregatedOutput','aggregated_output'],['stdout','stdout'],['stderr','stderr']]) {
      if (typeof raw[source] !== 'string') continue;
      if (out[field] == null) out[field] = raw[source];
      else if (out[field] !== raw[source]) conflicts.push({ itemId:item.id, kind:'output_conflict', field });
    }
    out.nativeReceipt = { source:'native_rollout_event', threadId, turnId, itemId:item.id,
      sha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
    return out;
  });
  return { items: reconciled, workerToolReceipts,
    nativeEvidence: { status: conflicts.length ? 'conflicting' : 'read', conflicts } };
}
