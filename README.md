# makefun-gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/eleanor-alt/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/eleanor-alt/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts every Grand Theft Auto VI (PlayStation 5) trophy's earn rate on Exophase at 2026-11-26T00:00:00Z, as five quantiles (5%, 25%, 50%, 75%, 95%) per trophy.

## How it works

A dependency-free Node 22 program (`main.ts`, standard library only, no network, deterministic). For each trophy it:

- works on the logit scale, with rates clamped to 0.01–99.99% (0% and 100% have no logit);
- fits a weighted least-squares line to logit(rate) against `ln(1 + hours since 2026-11-19T00:00:00Z)` over the case's reads, weighting recent reads more (24-hour half-life) — log-time matches how a launch-week trophy curve bends, fast early then a long tail, and keeps a 4.5-day extrapolation from running away;
- reads the fitted line at the target for the median;
- sets the spread from two honest sources combined: the random-walk scale `0.5 · sqrt(horizon in days)` and the fit's own residual scale, inflated by the leverage of extrapolating to the target — so the 4.5-day final horizon gets a far wider band than a 90-minute practice horizon.

Trophies with a flat history, too few usable reads, or missing rates fall back to the last rate with the random-walk spread only. The program reads every `*.in` case in the input directory and writes one `<id>.out` per case, byte-identical across runs.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=mfztwn6d&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
