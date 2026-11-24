import type { DailyBar, NewsItem } from '../types.js';

// Fabricated daily bars and news for research tests.

export function dailyBars(closes: number[], startDate = '2026-06-01', volume = 1_000_000): DailyBar[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return closes.map((close, index) => {
    const open = index === 0 ? close : (closes[index - 1] as number);
    return {
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume,
    };
  });
}

export function rampCloses(count: number, from = 100, step = 1): number[] {
  return Array.from({ length: count }, (_, index) => from + index * step);
}

export function newsItem(id: string, createdAt: string, headline = `headline ${id}`): NewsItem {
  return {
    id,
    headline,
    summary: `summary ${id}`,
    source: 'testwire',
    createdAt,
    url: `https://example.com/${id}`,
    symbols: ['TEST'],
  };
}
