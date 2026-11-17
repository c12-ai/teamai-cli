/**
 * Hook Dispatcher — unified entry point for teamai hooks.
 *
 * Instead of spawning N separate processes per event, Claude Code invokes
 * a single `teamai hook-dispatch <event> [--matcher <m>]` command.
 * The dispatcher reads STDIN once and fans out to all registered handlers.
 *
 * Design:
 *   - Handlers are pure functions: (stdin, tool, config) → output | null, where
 *     config is the scope the dispatcher resolved for the hook's cwd
 *   - Promise.allSettled ensures one handler crash doesn't take down others
 *   - Compatible structured outputs are merged so concurrent hints are preserved
 */

import type { LocalConfig } from './types.js';
import { log } from './utils/logger.js';

// ─── Public types ───────────────────────────────────────

export interface HookHandler {
  name: string;
  /**
   * `config` is the scope the dispatcher resolved for the hook's cwd, or null
   * when none applies (teamai not set up there, or its config unreadable).
   * Handlers read their scope from it, never from the process cwd: the
   * dispatcher's chdir into the hook's cwd can fail (#752).
   */
  execute(
    stdin: Record<string, unknown>, tool: string, config: LocalConfig | null,
    afterOutputWritten?: (acknowledge: () => Promise<void>) => void,
  ): Promise<string | null>;
}

export interface HandlerRegistration {
  event: string;
  matcher: string;
  handler: HookHandler;
  /** Per-handler timeout in ms. If exceeded, handler is treated as failed. */
  timeoutMs?: number;
  /**
   * Fire-and-forget handlers that never contribute STDOUT (pure side effects
   * like version-check, votes-sync, dashboard-report). The CLI runs these in a
   * detached background process so a slow network/registry call cannot delay
   * the host's hook completion. Foreground handlers (those that may return
   * output the host injects back into the session) always run inline.
   */
  background?: boolean;
  /**
   * Its context is left out when the merged reply is over the host's limit
   * and the other handlers' replies fit without it.
   */
  yieldsToContextLimit?: true;
}

/** The most characters Cursor takes as a hook's `additional_context`; over it, Cursor drops the whole reply. */
export const CURSOR_HOOK_CONTEXT_LIMIT = 10_000;

/** Characters of context in a merged reply, as Cursor counts them (trimmed). */
function contextLength(output: string | null): number {
  if (output === null) return 0;
  try {
    const context = asObject(asObject(JSON.parse(output))?.hookSpecificOutput)?.additionalContext;
    return typeof context === 'string' ? context.trim().length : 0;
  } catch {
    return 0;
  }
}

/** Which subset of matched handlers to run in a single dispatch pass. */
export type DispatchMode = 'all' | 'foreground' | 'background';

export interface DispatchError {
  handlerName: string;
  error: Error;
}

export interface DispatchResult {
  /** Run only after stdout accepts the final output; never serialized to the host. */
  acknowledgeOutput?: () => Promise<void>;
  /** Combined STDOUT output from all compatible output-producing handlers. */
  output: string | null;
  /** Errors from failed handlers (non-fatal — other handlers still ran). */
  errors: DispatchError[];
}

export interface DispatcherConfig {
  handlers: HandlerRegistration[];
  /** The scope every handler runs in; see HookHandler.execute. */
  localConfig: LocalConfig | null;
}

export interface Dispatcher {
  dispatch(
    event: string,
    matcher: string,
    stdin: Record<string, unknown>,
    tool: string,
    mode?: DispatchMode,
  ): Promise<DispatchResult>;
  /** True when the event+matcher has at least one background-marked handler. */
  hasBackground(event: string, matcher: string): boolean;
}

// ─── Implementation ─────────────────────────────────────

/** Default timeout: 60 seconds (matches Claude Code's default hook timeout). */
const DEFAULT_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/** Whether a handler's informational text survived merging in its original transport field. */
function retainsOutput(finalOutput: string | null, candidate: string): boolean {
  if (finalOutput === null) return false;
  if (finalOutput === candidate) return true;
  try {
    const original = asObject(JSON.parse(candidate));
    const merged = asObject(JSON.parse(finalOutput));
    if (!original || !merged) return false;
    let hasText = false;
    for (const field of ['systemMessage', 'followup_message']) {
      if (typeof original[field] !== 'string') continue;
      hasText = true;
      if (typeof merged[field] !== 'string' || !merged[field].includes(original[field])) return false;
    }
    if (Object.hasOwn(original, 'hookSpecificOutput')) {
      const before = asObject(original.hookSpecificOutput);
      const after = asObject(merged.hookSpecificOutput);
      if (!before || !after || before.hookEventName !== after.hookEventName
        || typeof before.additionalContext !== 'string' || typeof after.additionalContext !== 'string'
        || !after.additionalContext.includes(before.additionalContext)) return false;
      hasText = true;
    }
    return hasText;
  } catch { return false; }
}

/** Merge compatible hook output schemas used by the supported hosts. */
export function mergeHookOutputs(outputs: string[]): string | null {
  if (outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0];

  let parsed: JsonObject[];
  try {
    parsed = outputs.map((output) => {
      const value = asObject(JSON.parse(output));
      if (!value) throw new Error('Hook output is not an object');
      return value;
    });
  } catch {
    // Preserve the historical first-output behavior for unknown/plain schemas.
    return outputs[0];
  }

  if (parsed.some((value) => Object.hasOwn(value, 'systemMessage'))) {
    // Only informational fields are combined. Unknown/control fields retain
    // the historical first-output fallback rather than acquiring new semantics.
    const messages: string[] = [];
    const contexts: string[] = [];
    const followups: string[] = [];
    const eventNames = new Set<string>();
    for (const value of parsed) {
      if (Object.keys(value).some((key) => !['systemMessage', 'hookSpecificOutput', 'followup_message'].includes(key))) return outputs[0];
      if (Object.hasOwn(value, 'systemMessage')) {
        if (typeof value.systemMessage !== 'string') return outputs[0];
        messages.push(value.systemMessage);
      }
      if (Object.hasOwn(value, 'followup_message')) {
        if (typeof value.followup_message !== 'string') return outputs[0];
        followups.push(value.followup_message);
      }
      if (Object.hasOwn(value, 'hookSpecificOutput')) {
        const specific = asObject(value.hookSpecificOutput);
        if (!specific || Object.keys(specific).some((key) => !['hookEventName', 'additionalContext'].includes(key))
          || typeof specific.additionalContext !== 'string') return outputs[0];
        if (Object.hasOwn(specific, 'hookEventName')) {
          if (typeof specific.hookEventName !== 'string') return outputs[0];
          eventNames.add(specific.hookEventName);
        }
        contexts.push(specific.additionalContext);
      }
    }
    if (eventNames.size > 1) return outputs[0];
    const [hookEventName] = eventNames;
    return JSON.stringify({
      systemMessage: messages.join('\n'),
      ...followups.length > 0 ? { followup_message: followups.join('\n') } : {},
      ...contexts.length > 0 ? { hookSpecificOutput: {
        ...hookEventName !== undefined ? { hookEventName } : {},
        additionalContext: contexts.join('\n'),
      } } : {},
    });
  }

  const followups = parsed.map((value) => value.followup_message);
  if (followups.every((value): value is string => typeof value === 'string')) {
    return JSON.stringify({ ...parsed[0], followup_message: followups.join('\n') });
  }

  const specificOutputs = parsed.map((value) => asObject(value.hookSpecificOutput));
  if (specificOutputs.every((value): value is JsonObject => value !== null)) {
    const contexts = specificOutputs.map((value) => value.additionalContext);
    const eventNames = new Set(specificOutputs.map((value) => value.hookEventName).filter(Boolean));
    if (
      contexts.every((value): value is string => typeof value === 'string')
      && eventNames.size <= 1
    ) {
      return JSON.stringify({
        ...parsed[0],
        hookSpecificOutput: {
          ...specificOutputs[0],
          additionalContext: contexts.join('\n'),
        },
      });
    }
  }

  return outputs[0];
}

/**
 * Wrap a promise with a timeout. Rejects with a timeout error if not resolved in time.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, handlerName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Handler "${handlerName}" exceeded timeout of ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Create a dispatcher with the given handler registrations.
 *
 * Routing rules:
 *   - A handler matches if its event and matcher both match the dispatched hook.
 *   - The injected wildcard hook dispatches matcher='*' separately, so wildcard
 *     handlers must not also run during a specific matcher dispatch.
 */
export function createDispatcher(config: DispatcherConfig): Dispatcher {
  const matchedFor = (event: string, matcher: string) =>
    config.handlers.filter((reg) => reg.event === event && reg.matcher === matcher);

  return {
    hasBackground(event, matcher): boolean {
      return matchedFor(event, matcher).some((reg) => reg.background === true);
    },

    async dispatch(event, matcher, stdin, tool, mode = 'all'): Promise<DispatchResult> {
      // Find all handlers that should fire for this event+matcher, then narrow
      // to the requested mode so the inline pass and the detached background
      // pass each run their own subset.
      const matched = matchedFor(event, matcher).filter((reg) => {
        if (mode === 'foreground') return reg.background !== true;
        if (mode === 'background') return reg.background === true;
        return true;
      });

      // Execute all matched handlers concurrently with isolation + per-handler timeout
      const timings: Array<{ handler: string; ms: number; outcome: string }> = [];
      const startedAt = Date.now();
      const completions: Array<Array<() => Promise<void>>> = matched.map(() => []);
      const settled = await Promise.allSettled(
        matched.map((reg, index) => {
          const timeoutMs = reg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const handlerStartedAt = Date.now();
          const record = (outcome: string) => {
            timings.push({ handler: reg.handler.name, ms: Date.now() - handlerStartedAt, outcome });
          };
          return withTimeout(reg.handler.execute(stdin, tool, config.localConfig, (acknowledge) => completions[index].push(acknowledge)), timeoutMs, reg.handler.name).then(
            (value) => {
              record('ok');
              return value;
            },
            (err: unknown) => {
              // The message duplicates what hook-dispatch-cli already logs for a
              // failed handler; 'timeout' names the case that log cannot explain.
              record(err instanceof Error && /exceeded timeout/.test(err.message) ? 'timeout' : 'failed');
              throw err;
            },
          );
        }),
      );
      // Per-handler wall-clock, slowest first. Diagnostic only: every handler keeps
      // the caller's own timeout budget, so this reports what already happened
      // rather than changing it. Concurrent handlers make `total` the floor any
      // single handler imposes, not the sum — the gap between `total` and the
      // slowest handler is time spent in module loading before the handler ran.
      if (matched.length > 0) {
        const slowest = timings.reduce((a, b) => (b.ms > a.ms ? b : a), timings[0]);
        const detail = [...timings]
          .sort((a, b) => b.ms - a.ms)
          .map((t) => `${t.handler}=${t.ms}ms(${t.outcome})`)
          .join(' ');
        log.debug(`[hook-dispatch] ${event}/${tool} ${mode}: ${Date.now() - startedAt}ms total, ${matched.length} handlers, slowest ${slowest.handler}=${slowest.ms}ms | ${detail}`);
      }

      // Collect results
      const outputs: Array<{ reg: HandlerRegistration; value: string; index: number }> = [];
      const errors: DispatchError[] = [];

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        const handlerName = matched[i].handler.name;

        if (result.status === 'rejected') {
          errors.push({
            handlerName,
            error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
          });
        } else if (result.status === 'fulfilled' && result.value != null) {
          outputs.push({ reg: matched[i], value: result.value, index: i });
        }
      }

      let output = mergeHookOutputs(outputs.map(({ value }) => value));
      const length = contextLength(output);
      if (tool === 'cursor' && length > CURSOR_HOOK_CONTEXT_LIMIT && outputs.some(({ reg }) => reg.yieldsToContextLimit)) {
        const rest = mergeHookOutputs(outputs.filter(({ reg }) => !reg.yieldsToContextLimit).map(({ value }) => value));
        const yielded = outputs.filter(({ reg }) => reg.yieldsToContextLimit).map(({ reg }) => reg.handler.name).join(', ');
        if (contextLength(rest) <= CURSOR_HOOK_CONTEXT_LIMIT) {
          log.debug(`[hook-dispatch] ${event}/${tool}: reply context is ${length} characters, over the ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit; left out ${yielded}`);
          output = rest;
        } else {
          log.debug(`[hook-dispatch] ${event}/${tool}: reply context is ${length} characters, over the ${CURSOR_HOOK_CONTEXT_LIMIT}-character limit even without ${yielded}; Cursor drops it`);
        }
      }
      const acknowledgements = outputs.filter(({ value }) => retainsOutput(output, value))
        .flatMap(({ index }) => completions[index]);
      let acknowledged = false;
      return { output, errors, ...acknowledgements.length > 0 ? { acknowledgeOutput: async () => {
        if (acknowledged) return;
        acknowledged = true;
        for (const acknowledge of acknowledgements) {
          try { await acknowledge(); } catch (error) {
            log.debug(`hook-dispatch: output acknowledgement failed: ${String(error)}`);
          }
        }
      } } : {} };
    },
  };
}
