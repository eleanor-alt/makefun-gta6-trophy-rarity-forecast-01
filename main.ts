// gta6-trophy-rarity-forecast-01 entry (Node 22, standard library only): trend forecast.
// For every trophy of Grand Theft Auto VI on PlayStation 5, forecast its earn rate
// on Exophase at the case's target as five quantiles (0.05, 0.25, 0.5, 0.75, 0.95).
//
// Model, per trophy:
//   - Work on the logit scale, logit(p) = ln(p / (1 - p)), p = rate / 100, with
//     rates clamped to 0.01..99.99 (the scorer clamps the same way, and 0% / 100%
//     have no logit).
//   - Fit a weighted least-squares line to logit(rate) against
//     x = ln(1 + hours from 2026-11-19T00:00:00Z to the read). Log-time matches how
//     a launch-week trophy curve bends: fast early progress, then a long tail, and
//     it keeps a 4.5-day extrapolation from running away the way a line in raw
//     hours would. Reads are weighted by recency (half-life 24 h), so the stale
//     launch-night page and early dilution jumps matter less than the latest reads.
//   - The fitted slope is shrunk toward 0 before it is extrapolated: a slope is
//     only trusted as far as the data supports it. The shrinkage factor is
//     k = b^2 / (b^2 + se(b)^2), where se(b)^2 is the slope's variance under the
//     fit (residual variance divided by the spread of the reads in x), so a clean
//     trend keeps its full slope while a noisy one — short history, large
//     residuals — is damped toward the recent level. The shrunk line pivots on
//     the weighted mean (xBar, yBar), so shrinking pulls the target forecast
//     toward the recent level rather than toward the origin. A flat history has
//     slope 0 and residual 0, so it is unchanged; a perfect trend (residual 0)
//     keeps k = 1 and its full slope.
//   - Read the fitted line at the target's x for the median (logit), and combine
//     two honest sources of spread: the random-walk scale 0.5 * sqrt(horizon_days)
//     (the house baseline's, growing with the square root of the horizon) and the
//     fit's own residual scale, inflated by the leverage of extrapolating to the
//     target. The total spread is the square root of the sum of the two variances.
//   - Edge cases: a trophy whose history is flat (or has fewer than 3 usable reads,
//     or reads at fewer than 2 distinct times) falls back to the last rate with the
//     random-walk spread only — exactly the house baseline. Missing / null rates in
//     a read are skipped for that trophy. A trophy stuck at 100% stays near 100%:
//     its logit is clamped, so its quantiles hug the top of the range.
//   - Deterministic: no randomness, no wall clock — every time comes from the
//     case's own `at` / `target` fields, files are read in name order, and the
//     output is plain JSON.stringify, so two runs are byte-identical.
//
// Usage (local): mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Random-walk spread, in logit units per square-root day (the house baseline's). */
const SIGMA_RW = 0.5;
/** Recency half-life for read weights, in hours. */
const HALF_LIFE_H = 24;
/** Origin of the log-time axis: GTA VI's release day, 2026-11-19T00:00:00Z. */
const T0_MS = Date.parse('2026-11-19T00:00:00Z');
/** Hard cap on the total spread, in logit units, against wild histories. */
const SIGMA_MAX = 3;
/** Logit of 0.01% and of 99.99%: the clamp the scorer applies. */
const LOGIT_MIN = Math.log(0.01 / 99.99);
const LOGIT_MAX = -LOGIT_MIN;

interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Array<{ id: number }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

const clampRate = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const logisticPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Hours from the release-day origin to an ISO timestamp, as log-time. */
const logTime = (iso: string): number =>
  Math.log(1 + (Date.parse(iso) - T0_MS) / 3_600_000);

/**
 * Forecast one trophy. `points` are the usable (x, logit(rate)) reads, oldest
 * first, each with its recency weight; `lastRate` is the rate in the case's last
 * read (or the last non-null one); `xTarget` the target's log-time; `horizonDays`
 * the case horizon in days. Returns the median logit and the total spread. The
 * fitted slope is shrunk toward 0 by how well the data supports it (see the
 * shrinkage below) before the line is read at the target.
 */
function forecastTrophy(
  points: Array<{ x: number; y: number; w: number }>,
  lastRate: number,
  xTarget: number,
  horizonDays: number,
): { medianLogit: number; sigma: number } {
  const rw = SIGMA_RW * Math.sqrt(horizonDays);
  const fallback = { medianLogit: logit(lastRate), sigma: rw };

  // Need at least 3 reads at 2 distinct times to fit a line.
  const distinctX = new Set(points.map((p) => p.x)).size;
  if (points.length < 3 || distinctX < 2) return fallback;

  // Weighted least squares: y = a + b * x.
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (const p of points) {
    sw += p.w;
    swx += p.w * p.x;
    swy += p.w * p.y;
  }
  const xBar = swx / sw;
  const yBar = swy / sw;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += p.w * (p.x - xBar) * (p.x - xBar);
    sxy += p.w * (p.x - xBar) * (p.y - yBar);
  }
  if (!(sxx > 0) || !Number.isFinite(sxx) || !Number.isFinite(sxy)) return fallback;
  const b = sxy / sxx;
  const a = yBar - b * xBar;

  // Residual scale, with a small-sample correction; flat histories give 0.
  let swr2 = 0;
  let sw2 = 0;
  for (const p of points) {
    const r = p.y - (a + b * p.x);
    swr2 += p.w * r * r;
    sw2 += p.w * p.w;
  }
  const n = points.length;
  const nEff = (sw * sw) / sw2;
  const residVar = (swr2 / sw) * (n / Math.max(1, n - 2));
  // Shrink the fitted slope toward 0 by how much of it the data supports.
  // se(b)^2, the slope's variance under the fit, is residVar / sxx: when the
  // residuals are large next to the slope, or the reads span little log-time,
  // most of the slope is noise and the 4.5-day extrapolation would overshoot.
  // k = b^2 / (b^2 + se(b)^2) is 1 for a perfect fit and near 0 when the slope
  // is smaller than its own standard error. A flat history has b = 0, so the
  // shrunk slope is 0 and the median is the weighted mean level, as before.
  const seB2 = residVar / sxx;
  if (!Number.isFinite(seB2)) return fallback;
  const k = b * b > 0 ? (b * b) / (b * b + seB2) : 0;
  const bShrunk = k * b;
  // Prediction variance of the line at the target: residual scale times
  // (1 + 1/n_eff + leverage of the extrapolation).
  const leverage = (xTarget - xBar) * (xTarget - xBar) / sxx;
  const predVar = residVar * (1 + 1 / nEff + leverage);
  const sigma = Math.min(SIGMA_MAX, Math.sqrt(rw * rw + predVar));
  if (!Number.isFinite(sigma)) return fallback;

  // Read the shrunk line at the target, pivoting on the weighted mean so the
  // forecast is pulled toward the recent level, not toward the origin. The
  // spread is left as fitted from the unshrunk line: shrinkage narrows the
  // point forecast, and the unshrunk residual scale keeps the quantiles honest
  // about the noise the fit actually saw.
  const medianLogit = Math.min(
    LOGIT_MAX,
    Math.max(LOGIT_MIN, yBar + bShrunk * (xTarget - xBar)),
  );
  return { medianLogit, sigma };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!c.history || c.history.length === 0) throw new Error(`${file} has no history`);
  const checkpointMs = Date.parse(c.at);
  if (!Number.isFinite(checkpointMs)) throw new Error(`${file} has an unparsable checkpoint ${c.at}`);
  const horizonDays = c.horizon_minutes / 1440;
  const xTarget = logTime(c.target);

  const trophies = c.trophies.map((t, i) => {
    // Usable reads for this trophy: skip null rates. Weight by recency
    // against the checkpoint (half-life 24 h).
    const points: Array<{ x: number; y: number; w: number }> = [];
    let lastRate: number | null = null;
    for (const h of c.history) {
      const rate = h.rates[i];
      if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
      lastRate = rate;
      const ageH = Math.max(0, (checkpointMs - Date.parse(h.at)) / 3_600_000);
      points.push({ x: logTime(h.at), y: logit(rate), w: Math.pow(0.5, ageH / HALF_LIFE_H) });
    }
    if (lastRate === null) lastRate = 0.01; // no read ever listed this trophy
    const { medianLogit, sigma } = forecastTrophy(points, lastRate, xTarget, horizonDays);
    const q = Z.map((z) => round4(logisticPct(medianLogit + z * sigma)));
    // Rounding can only produce equal neighbours, never a decrease, but guard
    // the ordering explicitly so the row is valid by construction.
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
