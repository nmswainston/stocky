// Loads .env (Node's built-in loader, no dotenv dependency) and reads
// the secrets the research run needs. Keys are never logged or written
// to any output file.

export function loadDotEnv(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch {
    /* no .env file: rely on the real environment */
  }
}

export interface ResearchSecrets {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  secUserAgent: string;
  anthropicApiKey: string | null;
}

export function readSecrets(options: { needClaude: boolean }): ResearchSecrets {
  const missing: string[] = [];
  const get = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };
  const secrets: ResearchSecrets = {
    alpacaKeyId: get('ALPACA_API_KEY_ID'),
    alpacaSecretKey: get('ALPACA_API_SECRET_KEY'),
    secUserAgent: get('SEC_USER_AGENT'),
    anthropicApiKey: options.needClaude ? get('ANTHROPIC_API_KEY') : process.env.ANTHROPIC_API_KEY ?? null,
  };
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.join(', ')}. Copy .env.example to .env and fill it in (see README, Stock research).`,
    );
  }
  if (!/\S+@\S+/.test(secrets.secUserAgent)) {
    throw new Error('SEC_USER_AGENT must include a contact email, for example "Stocky research you@example.com"');
  }
  return secrets;
}
