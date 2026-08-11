// Local-time display helpers. Storage and the API speak UTC; only the
// dashboard converts, so the wall clock here matches the viewer's.
//
// lightweight-charts has no timezone option — it renders epoch seconds
// as UTC. toChartTime shifts each timestamp by its own UTC offset so
// the axis and crosshair read as local time (per-timestamp offset keeps
// bars straddling a DST change honest). Every `time:` fed to a chart,
// including markers, must go through it or they misalign.

export function toChartTime(iso) {
  const ms = Date.parse(iso);
  return Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60;
}

const pad = (n) => String(n).padStart(2, '0');

// "HH:MM:SS" for the trade tape.
export function localTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "HH:MM" for marker tooltips.
export function localMinute(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "MM-DD HH:MM" for the fills table.
export function localDateTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
