// Exact fixed-point arithmetic on decimal strings, scaled to 8 fractional
// digits to match DECIMAL(18, 8). Summing sizes as JS floats would drift;
// bigints do not.

const SCALE_DIGITS = 8;
const FACTOR = 10n ** BigInt(SCALE_DIGITS);

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

export function toUnits(decimalString: string): bigint {
  const match = DECIMAL_PATTERN.exec(decimalString);
  if (!match) throw new Error(`not a decimal string: ${decimalString}`);
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  // Digits beyond the 8th are truncated. Coinbase quotes at most 8.
  const fractionScaled = fraction.padEnd(SCALE_DIGITS, '0').slice(0, SCALE_DIGITS);
  const units = BigInt(whole) * FACTOR + BigInt(fractionScaled);
  return sign === '-' ? -units : units;
}

export function fromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(SCALE_DIGITS, '0')}`;
}
