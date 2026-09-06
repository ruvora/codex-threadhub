// Native execution records only. Do not infer child process success from prose
// or parse arbitrary Python/JS wrappers as if their children were observed.
export function commandText(item) {
  const value = item?.command ?? item?.cmd ?? item?.input?.command ?? item?.result?.command;
  return Array.isArray(value) ? value.join(' ') : String(value ?? '');
}

export function commandExitCode(item) {
  return [item?.exitCode, item?.exit_code, item?.result?.exitCode, item?.result?.exit_code, item?.status?.exitCode]
    .find(Number.isInteger) ?? null;
}

export function commandSucceeded(item) {
  return commandExitCode(item) === 0 && !['failed','error','running','inprogress','in_progress'].includes(String(item?.status?.type ?? item?.status ?? '').toLowerCase());
}

// One interpretation contract for workers, validators and dependency readers.
// A semantic exit result and an observed output buffer are different evidence.
export const COMMAND_EVIDENCE_POLICY = "Distinguish command outcome from output observation. For a literal diagnostic-free rg --files enumeration, exit code 1 supports no matches by command semantics; it does not prove that an empty output buffer was captured. When no output is exposed, say 'no matches inferred from exit code 1; output not available', never 'observed empty output'. Null or omitted output is unavailable, an explicit empty string is observed empty, and streamedOutput is partial evidence only. Do not infer test counts from exit code 0, source code, earlier runs or worker prose. Preserve missing evidence as unverified and do not rerun commands merely to manufacture receipts. Missing logs alone are not contradictory output; explicit unsupported observation claims still require correction.";

export function commandObservation(item) {
  const sources = [item, item?.result].filter(Boolean);
  const complete = sources.flatMap(source => ['aggregatedOutput', 'output'].map(key => source[key]))
    .filter(value => typeof value === 'string');
  const separate = sources.some(source => typeof source.stdout === 'string' && typeof source.stderr === 'string');
  const strings = sources.flatMap(source => ['aggregatedOutput', 'output', 'stdout', 'stderr', 'streamedOutput'].map(key => source[key]))
    .filter(value => typeof value === 'string');
  const hasContent = strings.some(value => value.length > 0);
  const outputObservation = complete.length || separate
    ? (hasContent ? 'captured' : 'observed_empty')
    : strings.length ? 'partial' : 'unavailable';
  return { command: commandText(item), exitCode: commandExitCode(item), outputObservation,
    ...(item.id ? { identity: { namespace: 'command_item', value: item.id } } : {}),
    outcome: isEmptyFileSearch(item) ? 'no_matches_by_exit_code'
      : commandSucceeded(item) ? 'succeeded' : commandExitCode(item) === null ? 'unknown' : 'not_succeeded' };
}

// Decode a single shell invocation without executing it. Reject expansion,
// redirection and compound commands rather than guessing which child failed.
function literalWords(text) {
  const words = [];
  let word = '', quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
    } else if (c === '\\' && quote !== "'") {
      if (++i === text.length) return null;
      word += text[i]; started = true;
    } else if (c === quote) {
      quote = null;
    } else if (!quote && (c === "'" || c === '"')) {
      quote = c; started = true;
    } else if (c === '$' || c === '`' || (!quote && /[;|&<>\n\r()]/.test(c))) {
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

export function isEmptyFileSearch(item) {
  if (commandExitCode(item) !== 1) return false;
  const status = String(item?.status?.type ?? item?.status ?? '').toLowerCase();
  if (!['completed', 'failed'].includes(status)) return false;
  // Exit 1 is benign only with no diagnostic or partial output. Never suppress
  // stderr, inaccessible-path errors, unknown wrappers or content assertions.
  for (const source of [item, item?.result]) {
    if (!source) continue;
    for (const key of ['aggregatedOutput', 'streamedOutput', 'output', 'stdout', 'stderr', 'error']) {
      if (source[key] != null && String(source[key]).trim()) return false;
    }
  }
  let words = literalWords(commandText(item));
  for (let depth = 0; depth < 2 && words?.length === 3
    && /^(?:.*\/)?(?:zsh|bash|sh)$/.test(words[0]) && ['-lc','-cl','-c'].includes(words[1]); depth++) {
    words = literalWords(words[2]);
  }
  if (!words || !['rg', '/usr/bin/rg', '/usr/local/bin/rg', '/opt/homebrew/bin/rg'].includes(words[0])) return false;
  const args = words.slice(1);
  if (!args.includes('--files')) return false;
  for (let i = 0; i < args.length; i++) {
    if (['--files', '--hidden', '--no-ignore'].includes(args[i])) continue;
    if (['-g', '--glob', '--iglob'].includes(args[i]) && args[i + 1]) { i++; continue; }
    if (/^--(?:glob|iglob)=.+/.test(args[i])) continue;
    return false;
  }
  return true;
}

export function isTestCommand(value, depth = 0) {
  const text = typeof value === 'string' ? value : commandText(value);
  // App Server serializes direct exec calls through the user's login shell.
  // Unwrap only that single command transport, never arbitrary scripts.
  const shell = text.match(/^(?:\/[^\s'"$`]+\/)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+(['"])([\s\S]*)\1$/);
  if (shell) {
    if (depth >= 2 || /[$`]/.test(shell[2])) return false;
    const inner = shell[1] === '"' ? shell[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : shell[2];
    return isTestCommand(inner, depth + 1);
  }
  // Conservatively handle one invocation, with quoted executable paths. Shell
  // pipelines/compound statements require separate native command receipts.
  if (/[;|&\n`]/.test(text) || text.includes('$(')) return false;
  const tokens = text.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(t => t.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  const exe = (tokens.shift() ?? '').split(/[\\/]/).at(-1);
  // Informational invocations can exit zero without executing any test.
  if (tokens.some(token => ['--help', '-h', '--version', '-v', '--listTests', '--collect-only', '--co'].includes(token))) return false;
  if (['node','node.exe'].includes(exe)) {
    for (let i=0;i<tokens.length;i++) {
      const token=tokens[i];
      if (token === '--test') return true;
      if (['-e','--eval','-p','--print','--'].includes(token) || !token.startsWith('-')) return false;
      if (['--import','--loader','--require','-r'].includes(token)) i++;
    }
    return false;
  }
  if (['npm','pnpm','yarn'].includes(exe)) return tokens[0] === 'test' || (tokens[0] === 'run' && tokens[1] === 'test');
  if (['pytest','vitest','jest'].includes(exe)) return true;
  return ['cargo','go','xcodebuild'].includes(exe) && tokens[0] === 'test';
}

export function supersededTestFailure(item, later) {
  const cwd = item.cwd ?? item.workingDirectory ?? item.input?.cwd;
  if (!cwd || !isTestCommand(item)) return false;
  return later.some(next => commandSucceeded(next)
    && commandText(next) === commandText(item)
    && (next.cwd ?? next.workingDirectory ?? next.input?.cwd) === cwd);
}
