import { describe, expect, it } from 'vitest';
import { heartbeatPinger } from './heartbeat.js';

function fakeFetcher(calls: string[], fail = false): typeof fetch {
  return (async (url: unknown) => {
    if (fail) throw new Error('offline');
    calls.push(String(url));
    return new Response('ok');
  }) as typeof fetch;
}

describe('heartbeatPinger', () => {
  it('pings the check URL on success and /fail on failure', async () => {
    const calls: string[] = [];
    const pinger = heartbeatPinger('https://hc.example/check', { fetcher: fakeFetcher(calls) });
    await pinger.success();
    await pinger.fail();
    expect(calls).toEqual(['https://hc.example/check', 'https://hc.example/check/fail']);
  });

  it('does nothing when no URL is configured', async () => {
    const calls: string[] = [];
    await heartbeatPinger(null, { fetcher: fakeFetcher(calls) }).success();
    await heartbeatPinger(undefined, { fetcher: fakeFetcher(calls) }).fail();
    expect(calls).toEqual([]);
  });

  it('swallows network errors and logs them instead', async () => {
    const lines: string[] = [];
    const pinger = heartbeatPinger('https://hc.example/check', {
      fetcher: fakeFetcher([], true),
      log: (line) => lines.push(line),
    });
    await expect(pinger.fail()).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('offline');
  });
});
