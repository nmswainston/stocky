import { ONE, divUnitsDown, fromUnits, mulUnitsDown, mulUnitsUp } from '../decimal.js';
import type { Fill } from './types.js';

// The one place fills come from. Both the backtest engine and the paper
// trader call these, so simulated history and simulated present can
// never drift apart in sizing, fees, slippage, or rounding.

export interface CostModel {
  buyFillPrice(referenceOpenUnits: bigint): bigint;
  sellFillPrice(referenceOpenUnits: bigint): bigint;
  fee(notionalUnits: bigint): bigint;
}

export const zeroCosts: CostModel = {
  buyFillPrice: (price) => price,
  sellFillPrice: (price) => price,
  fee: () => 0n,
};

export interface FillSite {
  executedAtBar: string;
  decidedAtBar: string;
  referenceOpen: string;
  openUnits: bigint;
}

export interface BuyResult {
  fill: Fill;
  quantityUnits: bigint;
  // Cash delta: notional plus fee.
  spentUnits: bigint;
  grossNotionalUnits: bigint;
  feeUnits: bigint;
  slippageUnits: bigint;
}

export function executeBuy(
  cashUnits: bigint,
  fractionBps: bigint,
  site: FillSite,
  costs: CostModel,
): BuyResult | null {
  const fillPriceUnits = costs.buyFillPrice(site.openUnits);
  const budget = (cashUnits * fractionBps) / 10_000n;
  // Size so that notional plus its fee fits the budget. Probing the fee
  // on 1.0 of notional gives the fee rate without assuming the model is
  // basis points; the decrement loop then only absorbs rounding.
  const feePerOne = costs.fee(ONE);
  const notionalTarget = (budget * ONE) / (ONE + feePerOne);
  let quantityUnits = divUnitsDown(notionalTarget, fillPriceUnits);
  let notionalUnits = mulUnitsUp(quantityUnits, fillPriceUnits);
  let feeUnits = costs.fee(notionalUnits);
  while (quantityUnits > 0n && notionalUnits + feeUnits > budget) {
    quantityUnits -= 1n;
    notionalUnits = mulUnitsUp(quantityUnits, fillPriceUnits);
    feeUnits = costs.fee(notionalUnits);
  }
  if (quantityUnits <= 0n) return null;
  const grossNotionalUnits = mulUnitsUp(quantityUnits, site.openUnits);
  return {
    fill: {
      side: 'BUY',
      executedAtBar: site.executedAtBar,
      decidedAtBar: site.decidedAtBar,
      referenceOpen: site.referenceOpen,
      fillPrice: fromUnits(fillPriceUnits),
      quantity: fromUnits(quantityUnits),
      notional: fromUnits(notionalUnits),
      fee: fromUnits(feeUnits),
    },
    quantityUnits,
    spentUnits: notionalUnits + feeUnits,
    grossNotionalUnits,
    feeUnits,
    // Slippage as the exact difference between what was paid and the
    // frictionless notional, so friction always sums exactly.
    slippageUnits: notionalUnits - grossNotionalUnits,
  };
}

export interface SellResult {
  fill: Fill;
  // Cash delta: notional minus fee.
  proceedsUnits: bigint;
  grossNotionalUnits: bigint;
  feeUnits: bigint;
  slippageUnits: bigint;
}

export function executeSell(
  positionUnits: bigint,
  site: FillSite,
  costs: CostModel,
): SellResult {
  const fillPriceUnits = costs.sellFillPrice(site.openUnits);
  const notionalUnits = mulUnitsDown(positionUnits, fillPriceUnits);
  const feeUnits = costs.fee(notionalUnits);
  const grossNotionalUnits = mulUnitsDown(positionUnits, site.openUnits);
  return {
    fill: {
      side: 'SELL',
      executedAtBar: site.executedAtBar,
      decidedAtBar: site.decidedAtBar,
      referenceOpen: site.referenceOpen,
      fillPrice: fromUnits(fillPriceUnits),
      quantity: fromUnits(positionUnits),
      notional: fromUnits(notionalUnits),
      fee: fromUnits(feeUnits),
    },
    proceedsUnits: notionalUnits - feeUnits,
    grossNotionalUnits,
    feeUnits,
    slippageUnits: grossNotionalUnits - notionalUnits,
  };
}
