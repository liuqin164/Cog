# Changelog

## 5.0.0 (unreleased)

- **The ten-year cost is measured, not guessed (#238).** `scripts/measure-decade-curve.ts` builds the decade ledger at the year-scale corpus's own write intensity (10,020 turns a year, about 27 a day) and records write-time compile and recall latency at each year boundary; the measured result is on #238. **Only measurement:** no kernel, recall or storage behaviour changes.

- **A slow contamination now has a weekly clean point (#238).** The nightly snapshot still keeps seven copies, and the first verified snapshot of each ISO week is also copied to `archive-<ISO-week>.snap` / `.json`; the newest four weekly archives are kept. An archive passes the same `checksum`, `opens` and `counts` verification, and F19's restore drill is unchanged. **What pays for it:** one copy step and one ISO-week key inside `BrainBackup`; no new table, dependency, bin or format — an archive is a snapshot with a different name. `__tests__/health-backup.contract.test.ts` pins the four-week window, the verification and the pruning. User-visible effect, in one line: a contamination noticed on day eight can be rolled back to a clean point up to four weeks old instead of only seven nights.
