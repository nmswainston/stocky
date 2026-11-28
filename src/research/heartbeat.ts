// Dead-man ping for the research run, the same healthchecks.io pattern
// the collector uses with STOCKY_HEARTBEAT_URL: a success pings the
// check URL, a failure pings <url>/fail so the monitor pages at once
// instead of waiting out the grace period. A run that never starts
// sends nothing, and the monitor alerts on the silence. Unset means
// disabled. Pings never throw: alerting must not break the run it
// watches.

export interface HeartbeatPinger {
  success(): Promise<void>;
  fail(): Promise<void>;
}

export function heartbeatPinger(
  url: string | null | undefined,
  options: { fetcher?: typeof fetch; log?: (line: string) => void } = {},
): HeartbeatPinger {
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? (() => {});
  const ping = async (suffix: '' | '/fail'): Promise<void> => {
    if (!url) return;
    try {
      await fetcher(`${url}${suffix}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      log(`heartbeat ping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    success: () => ping(''),
    fail: () => ping('/fail'),
  };
}
