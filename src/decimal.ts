// Exact fixed-point arithmetic on decimal strings, scaled to 8 fractional
// digits to match DECIMAL(18, 8). Summing sizes as JS floats would drift;
// bigints do not.

const SCALE_DIGITS = 8;
const FACTOR = 10n ** BigInt(SCALE_DIGITS);

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

// The unit representation of 1.0, for callers doing ratio math on units.
export const ONE = FACTOR;

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

// Product of two unit values (for example quantity times price), scaled
// back down. Direction of rounding is the caller's choice because in
// trade accounting it should always round against the trader.
export function mulUnitsDown(a: bigint, b: bigint): bigint {
  return (a * b) / FACTOR;
}

export function mulUnitsUp(a: bigint, b: bigint): bigint {
  const product = a * b;
  return product % FACTOR === 0n ? product / FACTOR : product / FACTOR + 1n;
}

// Quotient of two unit values (for example notional divided by price
// giving quantity), rounded down so a buyer never oversubscribes cash.
export function divUnitsDown(numerator: bigint, denominator: bigint): bigint {
  return (numerator * FACTOR) / denominator;
}

// value * bps / 10000, rounded up. Used for fees so they are never
// understated by rounding.
export function bpsOfUp(units: bigint, bps: number): bigint {
  const numerator = units * BigInt(bps);
  return numerator % 10_000n === 0n ? numerator / 10_000n : numerator / 10_000n + 1n;
}

// value scaled by (10000 + bps) / 10000 rounded up, or
// (10000 - bps) / 10000 rounded down. Used for slippage on a price:
// buys fill higher, sells fill lower, both against the trader.
export function addBpsUp(units: bigint, bps: number): bigint {
  const numerator = units * BigInt(10_000 + bps);
  return numerator % 10_000n === 0n ? numerator / 10_000n : numerator / 10_000n + 1n;
}

export function subtractBpsDown(units: bigint, bps: number): bigint {
  return (units * BigInt(10_000 - bps)) / 10_000n;
}

export function fromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  return `${sign}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(SCALE_DIGITS, '0')}`;
}
