/**
 * ntfy push notifications. Best-effort: a failed push never breaks a run.
 * Disabled (a no-op) when NTFY_URL / NTFY_TOPIC are not configured.
 */

export const NOTIFY_PRIORITY_DEFAULT = 3;
export const NOTIFY_PRIORITY_HIGH = 4;
export const NOTIFY_PRIORITY_URGENT = 5;

export interface Notifier {
  send(title: string, body: string, priority?: number): Promise<void>;
}

export interface NotifyConfig {
  ntfyUrl: string | null;
  ntfyTopic: string | null;
  /** Bounded because a best-effort side channel must never freeze delivery. */
  timeoutMs?: number;
}

/** A notifier that POSTs to ntfy, or silently no-ops when unconfigured. */
export function createNotifier(config: NotifyConfig): Notifier {
  const { ntfyUrl, ntfyTopic } = config;
  const timeoutMs = Math.max(1, config.timeoutMs ?? 10_000);
  if (!ntfyUrl || !ntfyTopic) {
    return { send: async () => undefined };
  }
  const endpoint = `${ntfyUrl.replace(/\/+$/, "")}/${ntfyTopic}`;
  return {
    async send(title, body, priority = NOTIFY_PRIORITY_DEFAULT) {
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { Title: title, Priority: String(priority) },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // best-effort; delivery is not load-bearing
      }
    },
  };
}
