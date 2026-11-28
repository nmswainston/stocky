// Push notification after a successful research run, sent through ntfy
// (ntfy.sh or self-hosted): one short message with the day's scores, by
// plain POST, no SDK. Optional like the heartbeat: no URL configured
// means no push. Send failures are logged and never thrown, because a
// missed notification must not fail a run that already wrote its
// digest. The message holds symbols, scores and cost only: no keys, no
// thesis text from outside sources.

export interface PushMessage {
  title: string;
  body: string;
}

export interface PushSource {
  marketDate: string;
  costUsd: number;
  budgetUsd: number;
  theses: { symbol: string; score: number; confidence: string }[];
  rows: { symbol: string; discovered: boolean }[];
}

function signed(score: number): string {
  return score > 0 ? `+${score}` : String(score);
}

export function pushMessage(result: PushSource): PushMessage {
  const discovered = new Set(result.rows.filter((row) => row.discovered).map((row) => row.symbol));
  const sorted = [...result.theses].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const lines = sorted.map(
    (thesis) =>
      `${thesis.symbol} ${signed(thesis.score)} (${thesis.confidence}${discovered.has(thesis.symbol) ? ', new find' : ''})`,
  );
  if (lines.length === 0) lines.push('No theses today.');
  lines.push(`$${result.costUsd.toFixed(2)} of $${result.budgetUsd.toFixed(2)} spent`);
  return { title: `Stock research ${result.marketDate}`, body: lines.join('\n') };
}

export async function sendPush(
  url: string | null | undefined,
  message: PushMessage,
  options: { clickUrl?: string | null; fetcher?: typeof fetch; log?: (line: string) => void } = {},
): Promise<void> {
  if (!url) return;
  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? (() => {});
  const headers: Record<string, string> = { Title: message.title };
  if (options.clickUrl) headers.Click = options.clickUrl;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: message.body,
      signal: AbortSignal.timeout(10_000),
    });
    // fetch resolves on HTTP errors; a 401 or 429 is still a failed
    // delivery and deserves a log line.
    if (!response.ok) log(`push notification rejected: HTTP ${response.status}`);
  } catch (error) {
    log(`push notification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
