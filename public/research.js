// Stock research page. Reads /api/research and /api/research/<date>;
// it has no controls that change anything. Every value from the data
// goes in through textContent, never innerHTML, because headlines and
// labels come from outside sources.

const $ = (id) => document.getElementById(id);

function make(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.className) node.className = options.className;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function pct(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function money(value) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(2);
}

function signed(score) {
  return score > 0 ? `+${score}` : String(score);
}

function tone(value) {
  if (value === null || value === undefined || value === 0) return '';
  return value > 0 ? 'up' : 'down';
}

function shortDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const UNIVERSE_LABELS = {
  large: 'the large-cap list',
  small: 'the small-cap list',
  both: 'the large and small-cap lists',
  custom: 'a custom list',
};

// 'claude-sonnet-5-5' reads as 'Sonnet 5.5'; anything unexpected shows
// as it came, never hidden.
function modelName(model) {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!match) return model;
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
}

function scoreWord(score) {
  if (score >= 3) return 'strong candidate';
  if (score >= 1) return 'leans positive';
  if (score <= -3) return 'avoid';
  if (score <= -1) return 'leans negative';
  return 'neutral';
}

// Cite marks jump to the numbered source, opening the sources list first.
function citeMarks(symbol, cites) {
  const wrap = make('span', { className: 'cites' });
  for (const n of cites) {
    const link = make('a', {
      text: String(n),
      attrs: { href: `#${symbol}-src-${n}`, 'aria-label': `source ${n}` },
    });
    link.addEventListener('click', () => {
      const details = $(`${symbol}-sources`);
      if (details) details.open = true;
    });
    wrap.append(make('sup', {}, [link]));
  }
  return wrap;
}

function pointList(symbol, heading, points) {
  if (points.length === 0) return null;
  const list = make('ul', { className: 'points' });
  for (const item of points) {
    list.append(make('li', {}, [document.createTextNode(`${item.point} `), citeMarks(symbol, item.cites)]));
  }
  return make('div', {}, [make('h4', { text: heading }), list]);
}

function sourceList(thesis) {
  if (thesis.sources.length === 0) return null;
  const list = make('ol', { className: 'sources' });
  for (const source of thesis.sources) {
    const item = make('li', { attrs: { id: `${thesis.symbol}-src-${source.n}`, value: String(source.n) } });
    if (source.url) {
      item.append(make('a', { text: source.label, attrs: { href: source.url, rel: 'noopener noreferrer', target: '_blank' } }));
    } else {
      item.textContent = source.label;
    }
    list.append(item);
  }
  return make('details', { attrs: { id: `${thesis.symbol}-sources` } }, [
    make('summary', { text: `Sources (${thesis.sources.length})` }),
    list,
  ]);
}

function thesisCard(thesis) {
  const headingId = `thesis-${thesis.symbol}`;
  const title = make('h3', { attrs: { id: headingId } }, [
    document.createTextNode(thesis.symbol),
    thesis.companyName ? make('span', { className: 'company', text: ` ${thesis.companyName}` }) : null,
    thesis.discovered ? make('span', { className: 'badge', text: 'New find' }) : null,
  ]);
  const score = make('p', { className: `score ${tone(thesis.score)}` }, [
    make('span', { className: 'score-num', text: signed(thesis.score) }),
    make('span', { text: ` ${scoreWord(thesis.score)}, ${thesis.confidence} confidence` }),
  ]);

  const facts = [];
  if (thesis.lastClose !== null) facts.push(`Close ${money(thesis.lastClose)}${thesis.lastDate ? ` (${shortDate(thesis.lastDate)})` : ''}`);
  if (thesis.return20d !== null) facts.push(`20 day ${pct(thesis.return20d)}`);
  if (thesis.vsBenchmark20d !== null) facts.push(`vs SPY ${pct(thesis.vsBenchmark20d)}`);
  if (thesis.model) facts.push(`by ${modelName(thesis.model)}`);

  const flagged = thesis.verified
    ? null
    : make('p', { className: 'flag', text: `Checks flagged: ${thesis.problems.join('; ')}` });

  return make('article', { className: 'thesis', attrs: { 'aria-labelledby': headingId } }, [
    make('header', {}, [title, score]),
    thesis.summary ? make('p', { className: 'summary', text: thesis.summary }) : null,
    facts.length > 0 ? make('p', { className: 'facts', text: facts.join(' · ') }) : null,
    pointList(thesis.symbol, 'For', thesis.bull),
    pointList(thesis.symbol, 'Against', thesis.bear),
    thesis.watchFor.length > 0 ? make('p', { className: 'watch', text: `Watch for: ${thesis.watchFor.join('; ')}` }) : null,
    flagged,
    sourceList(thesis),
  ]);
}

function renderMeta(day) {
  const parts = [];
  if (day.asOf) {
    parts.push(`As of ${new Date(day.asOf).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`);
  }
  if (day.dryRun) parts.push('Dry run: data only, no AI calls.');
  else parts.push(`${day.theses.length} ${day.theses.length === 1 ? 'thesis' : 'theses'}.`);
  if (!day.dryRun && day.costUsd !== null) {
    parts.push(`Cost $${day.costUsd.toFixed(2)}${day.budgetUsd !== null ? ` of a $${day.budgetUsd.toFixed(2)} cap` : ''}.`);
  }
  $('run-meta').textContent = parts.join(' ');
}

function renderTheses(day) {
  const box = $('theses');
  box.replaceChildren();
  if (day.theses.length === 0) {
    box.append(make('p', {
      className: 'empty',
      text: day.dryRun ? 'Dry runs write no theses. The watchlist below is still current.' : 'No theses for this day.',
    }));
    return;
  }
  for (const thesis of day.theses) box.append(thesisCard(thesis));
}

function renderWatchlist(day) {
  const body = $('watch-table').querySelector('tbody');
  body.replaceChildren();
  const cell = (text, className = '') => make('td', { text, className });
  for (const row of day.watchlist) {
    const name = make('th', { attrs: { scope: 'row' } }, [
      document.createTextNode(row.symbol),
      row.discovered ? make('span', { className: 'badge', text: 'New' }) : null,
      row.dataProblems.length > 0 ? make('span', { className: 'warn', text: ' !', attrs: { title: row.dataProblems.join('; '), 'aria-label': `data problem: ${row.dataProblems.join('; ')}` } }) : null,
    ]);
    body.append(make('tr', {}, [
      name,
      cell(money(row.lastClose), 'num'),
      cell(pct(row.return5d), `num ${tone(row.return5d)}`),
      cell(pct(row.return20d), `num ${tone(row.return20d)}`),
      cell(pct(row.vsBenchmark20d), `num ${tone(row.vsBenchmark20d)}`),
      cell(row.researched ? 'Yes' : ''),
    ]));
  }
  if (day.watchlist.length === 0) {
    body.append(make('tr', {}, [make('td', { text: 'No watchlist saved.', attrs: { colspan: '6' } })]));
  }

  const skipped = $('skipped');
  skipped.replaceChildren();
  if (day.skipped.length > 0) {
    const list = make('ul');
    for (const item of day.skipped) list.append(make('li', { text: `${item.symbol}: ${item.reason}` }));
    skipped.append(make('h3', { text: 'Not researched' }), list);
  }
}

// Names the morning scan added from beyond the watchlist, with why.
function renderFinds(day) {
  const section = $('finds-section');
  const list = $('finds');
  list.replaceChildren();
  const scan = day.discovery;
  if (!scan) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const found = day.watchlist.filter((row) => row.discovered);
  const lists = UNIVERSE_LABELS[day.universeMode] ? ` (${UNIVERSE_LABELS[day.universeMode]})` : '';
  $('finds-meta').textContent = found.length > 0
    ? `Added from a scan of ${scan.scanned} US stocks${lists} beyond your watchlist. Marked New in the table below.`
    : `Scanned ${scan.scanned} US stocks${lists} beyond your watchlist. Nothing unusual enough to add today.`;
  for (const row of found) {
    const status = row.researched ? 'researched above' : 'not researched today';
    list.append(make('li', { text: `${row.symbol}: ${row.discoveryReason ?? 'unusual activity'}, ${status}.` }));
  }
}

// Track record: every live thesis graded against SPY once its horizon
// has passed. Written by the research run; absent until the first
// refresh, and the section stays hidden then.
async function loadScorecard() {
  let summary;
  try {
    const response = await fetch('/api/research/scorecard', { cache: 'no-store' });
    if (!response.ok) return;
    summary = await response.json();
  } catch {
    return;
  }
  const tables = $('record-tables');
  tables.replaceChildren();
  const metaParts = [
    `Every thesis graded against ${summary.benchmark}: entry at the next open after it was written, exit N sessions later.`,
    'Positive is scores +2 and up, negative -2 and down.',
    `${summary.liveTheses} ${summary.liveTheses === 1 ? 'thesis' : 'theses'} on file.`,
  ];
  if (summary.asOfExcluded > 0) metaParts.push(`${summary.asOfExcluded} as-of replays excluded.`);
  if (summary.generatedAt) metaParts.push(`Refreshed ${shortDate(summary.generatedAt.slice(0, 10))}.`);
  $('record-meta').textContent = metaParts.join(' ');

  for (const entry of summary.horizons ?? []) {
    const caption = `${entry.horizon} sessions ahead${entry.ungraded > 0 ? ` (${entry.ungraded} too recent to grade)` : ''}`;
    if (entry.graded === 0) {
      tables.append(make('p', { className: 'hint', text: `${caption}: nothing graded yet.` }));
      continue;
    }
    const head = make('thead', {}, [
      make('tr', {}, [
        make('th', { text: 'Score', attrs: { scope: 'col' } }),
        make('th', { text: 'Theses', className: 'num', attrs: { scope: 'col' } }),
        make('th', { text: `Beat ${summary.benchmark}`, className: 'num', attrs: { scope: 'col' } }),
        make('th', { text: `Avg vs ${summary.benchmark}`, className: 'num', attrs: { scope: 'col' } }),
      ]),
    ]);
    const body = make('tbody');
    for (const bucket of entry.buckets) {
      if (bucket.count === 0) continue;
      // "Positive (+2 to +5)" reads fine on a desktop but forces the
      // last column off a phone screen; one word fits everywhere.
      const word = bucket.label.split(' ')[0];
      body.append(make('tr', {}, [
        make('th', { text: word, attrs: { scope: 'row', title: bucket.label } }),
        make('td', { text: String(bucket.count), className: 'num' }),
        make('td', { text: `${Math.round(bucket.hitRate * 100)}%`, className: 'num' }),
        make('td', { text: pct(bucket.meanExcess), className: `num ${tone(bucket.meanExcess)}` }),
      ]));
    }
    tables.append(
      make('h3', { text: caption }),
      make('div', { className: 'table-wrap', attrs: { role: 'region', 'aria-label': caption, tabindex: '0' } }, [
        make('table', {}, [head, body]),
      ]),
    );
  }
  $('record-section').hidden = false;
}

async function loadDay(date) {
  $('run-meta').textContent = 'Loading...';
  const response = await fetch(`/api/research/${encodeURIComponent(date)}`, { cache: 'no-store' });
  if (!response.ok) {
    $('run-meta').textContent = `Could not load research for ${date}.`;
    return;
  }
  const day = await response.json();
  renderMeta(day);
  renderTheses(day);
  renderFinds(day);
  renderWatchlist(day);
  const url = new URL(location.href);
  url.searchParams.set('date', date);
  history.replaceState(null, '', url);
}

async function start() {
  const select = $('day-select');
  let days = [];
  try {
    const response = await fetch('/api/research', { cache: 'no-store' });
    days = (await response.json()).days ?? [];
  } catch {
    $('run-meta').textContent = 'Could not reach Stocky. Is the collector running?';
    return;
  }
  select.replaceChildren();
  if (days.length === 0) {
    select.append(new Option('No research yet', ''));
    $('run-meta').textContent = 'No research yet. Run npm run research on the server, then reload.';
    return;
  }
  for (const day of days) {
    const label = `${shortDate(day.date)}${day.dryRun ? ' (dry run)' : ` · ${day.thesisCount} theses`}`;
    select.append(new Option(label, day.date));
  }
  const wanted = new URL(location.href).searchParams.get('date');
  select.value = days.some((day) => day.date === wanted) ? wanted : days[0].date;
  select.disabled = false;
  select.addEventListener('change', () => loadDay(select.value));
  $('day-form').addEventListener('submit', (event) => event.preventDefault());
  await loadDay(select.value);
  await loadScorecard();
}

start();
