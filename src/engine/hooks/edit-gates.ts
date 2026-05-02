/**
 * First-touch edit gates.
 *
 * Blocks the first Edit/Write/MultiEdit to a file in a session until the
 * agent has demonstrably looked at it — defined as: the path appears in
 * any prior turn text, recall result, retrieval injection, or user message.
 * The point is to enforce "RECALL BEFORE GUESSING" at the substrate level
 * instead of leaving it to model self-discipline.
 *
 * Strict mode also gates destructive Bash patterns (rm -rf, git reset
 * --hard, git push --force, DROP TABLE, DELETE FROM without WHERE,
 * TRUNCATE) on first attempt per session, requiring user authorization
 * or prior session mention before allowing.
 *
 * State storage:
 *   - In-memory cache per session (SessionState._editGateChecked) for
 *     hot paths. Wiped on idle timeout.
 *   - Cold-path fallback queries the existing turn table — no new schema.
 *
 * Idle timeout: a session that hasn't gated anything in 30 minutes
 * resets its in-memory cache (the agent's intent has likely shifted).
 * Configurable via KONGCODE_GATE_TIMEOUT_MS.
 *
 * Override: a user message containing the file path verbatim acts as
 * authorization (the user just told the agent what to do).
 */

import type { GlobalPluginState, SessionState } from "../state.js";
import type { HookResponse } from "../../http-api.js";
import { swallow } from "../errors.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function readIdleTimeout(): number {
  const raw = process.env.KONGCODE_GATE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

/** Destructive Bash patterns gated under `strict`. Order matters — most
 *  specific first so error messages are informative. */
const DESTRUCTIVE_BASH_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "rm -rf", re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/ },
  { name: "git reset --hard", re: /\bgit\s+reset\s+--hard\b/ },
  { name: "git push --force", re: /\bgit\s+push\s+(--force\b|-f\b|--force-with-lease\b)/ },
  { name: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { name: "DELETE FROM (no WHERE)", re: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i },
  { name: "TRUNCATE TABLE", re: /\bTRUNCATE\s+(TABLE\s+)?\w+/i },
];

function maybeWipeIdleCache(session: SessionState): void {
  const now = Date.now();
  const last = session._editGateLastActivity ?? 0;
  if (last > 0 && now - last > readIdleTimeout()) {
    session._editGateChecked.clear();
  }
  session._editGateLastActivity = now;
}

/** Returns true if the file path has been "investigated" this session. */
async function hasInvestigatedFile(
  state: GlobalPluginState,
  session: SessionState,
  filePath: string,
): Promise<boolean> {
  if (session._editGateChecked.has(filePath)) return true;

  // The user's most recent message naming the file is an authorization.
  if (session.lastUserText && session.lastUserText.includes(filePath)) {
    session._editGateChecked.add(filePath);
    return true;
  }

  // Cold path: graph query for any prior turn mentioning this exact path
  // in this session. Costs one CONTAINS scan; cached on hit.
  if (!state.store.isAvailable() || !session.surrealSessionId) {
    // No store / no session row — fail open. We can't enforce without
    // state, and blocking blindly would be hostile.
    return true;
  }

  try {
    const rows = await state.store.queryFirst<{ id: string }>(
      `SELECT id FROM turn
         WHERE session_id = $sid
           AND text CONTAINS $path
       LIMIT 1`,
      { sid: session.surrealSessionId, path: filePath },
    );
    if (rows.length > 0) {
      session._editGateChecked.add(filePath);
      return true;
    }
  } catch (e) {
    swallow.warn("editGate:queryTurns", e);
    // Fail open on store error — the gate is an enhancement, not a brick wall.
    return true;
  }

  return false;
}

/** Returns true if the destructive command has been seen / authorized this session. */
async function hasInvestigatedBashCommand(
  state: GlobalPluginState,
  session: SessionState,
  command: string,
  matchedPattern: string,
): Promise<boolean> {
  // Internal cache key prefixed so it can't collide with file paths.
  const cacheKey = `__bash__:${matchedPattern}`;
  if (session._editGateChecked.has(cacheKey)) return true;

  // User message authorization: command must appear verbatim, OR the user
  // explicitly named the destructive verb.
  if (
    session.lastUserText &&
    (session.lastUserText.includes(command.trim()) ||
      session.lastUserText.toLowerCase().includes(matchedPattern.toLowerCase()))
  ) {
    session._editGateChecked.add(cacheKey);
    return true;
  }

  if (!state.store.isAvailable() || !session.surrealSessionId) return true;

  try {
    const rows = await state.store.queryFirst<{ id: string }>(
      `SELECT id FROM turn
         WHERE session_id = $sid
           AND text CONTAINS $needle
       LIMIT 1`,
      { sid: session.surrealSessionId, needle: matchedPattern },
    );
    if (rows.length > 0) {
      session._editGateChecked.add(cacheKey);
      return true;
    }
  } catch (e) {
    swallow.warn("editGate:queryBash", e);
    return true;
  }
  return false;
}

function denyResponse(reason: string): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Run the first-touch check for an Edit/Write/MultiEdit call.
 * Returns a deny HookResponse if the gate should fire, null otherwise.
 */
export async function checkFileEditGate(
  state: GlobalPluginState,
  session: SessionState,
  filePath: string,
): Promise<HookResponse | null> {
  if (!filePath) return null;
  maybeWipeIdleCache(session);
  const investigated = await hasInvestigatedFile(state, session, filePath);
  if (investigated) return null;

  return denyResponse(
    `kongcode/edit-gate: first edit to ${filePath} this session. ` +
      `Run \`recall("${filePath}")\` or read the file before editing — otherwise you're ` +
      `editing blind. The gate fires once per file per session and clears once the path ` +
      `appears in any subsequent turn.`,
  );
}

/**
 * Run the destructive-command check for a Bash call (strict mode only).
 * Matches the command against destructive patterns; if matched, requires
 * either user authorization or prior session mention.
 */
export async function checkBashGate(
  state: GlobalPluginState,
  session: SessionState,
  command: string,
): Promise<HookResponse | null> {
  if (!command) return null;
  maybeWipeIdleCache(session);

  const match = DESTRUCTIVE_BASH_PATTERNS.find((p) => p.re.test(command));
  if (!match) return null;

  const investigated = await hasInvestigatedBashCommand(state, session, command, match.name);
  if (investigated) return null;

  return denyResponse(
    `kongcode/bash-gate: destructive pattern detected: ${match.name}. ` +
      `Either the user must authorize this command, or you must surface context ` +
      `establishing why the destructive operation is correct (recall the target path or ` +
      `the relevant decision). Once acknowledged, retry — the gate fires once per pattern ` +
      `per session.`,
  );
}
