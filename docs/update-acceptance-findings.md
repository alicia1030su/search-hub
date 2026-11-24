# Update acceptance: real findings

This file records what the cross-version and fault-injection tests actually found.
Every item below was reproduced, then fixed in the same PR. Items 1–12 and the
original counts are historical v0.1.6 evidence; the v0.1.15 addendum below records
the current updater behavior without rewriting history.

## Real defects found by the tests

| # | Defect | How it surfaced | Fix |
|---|---|---|---|
| 1 | **The released package shipped no updater.** `bin/updater.mjs` lived only in the repository, so a downloaded install could not upgrade itself at all. | `upgrade-matrix.mjs` looked for `bin/updater.mjs` in the extracted v0.1.4-beta.6 package and found nothing. | `build-package.mjs` now ships `bin/updater.mjs`, `bin/updater-core.mjs` and `bin/update`/`update.cmd`; the package README documents the command. |
| 2 | **`/api/health` reported a hardcoded version.** `config.ts` returned `"0.1.4"` regardless of what was installed, so the updater's "did the new build take over?" check could never pass. | The upgrade test compared the installed version with the health response; the health response never changed. | `resolveVersion()` reads `launcher.json` → `package.json` → `SEARCH_HUB_VERSION`, preferring the package manifest because `app/package.json` still carries the build-time value. |
| 3 | **The updater never stamped the manifest.** Installing new program files left the old `launcher.json`, so even a correct binary reported the previous version. | Same check, after fixing #2: the new build started but claimed `0.1.0`. | `stampVersion()` writes the target version into `launcher.json` / `package.json` after the swap. |
| 4 | **Health probe accepted any HTTP 200.** An old build still bound to the port made a failed update look successful. | Fault-injection case E: the "hang" package never listened, yet the probe reported success because a leftover server answered. | The probe now requires `body.version === expected`; a foreign build is reported as `stale` and treated as failure. |
| 5 | **Rollback used `rm -rf` on the failed tree.** On Windows the failed build still holds file handles, so removal failed with `EBUSY` and the install was left with **no working program**. | Fault-injection case E returned exit 4 instead of 3. | Rollback renames the failed tree to `app.failed-<ts>` (a rename only needs the parent to be writable) and renames the previous tree back. |
| 6 | **Health-skipped sources were invisible.** When the health gate parked a source, the search response said nothing — the caller just saw a smaller fan-out. | Health audit: blocked provider did not appear in `failedSources`. | Skipped sources are appended to `errors` / `failedSources`, `stats.partial` is set and `status` drops to `partial`. |
| 7 | **`secret-scan` history mode had a false positive.** A `g`-flagged regex kept its `lastIndex` between `git grep` lines, so an allowlisted value was reported as a violation. | CI's "Dependency audit and secret scan" failed on a line whose value *is* allowlisted. | `re.lastIndex = 0` before each line's match. |
| 8 | **Asset names hid the prerelease.** Release assets are named from `package.json` (`0.1.6`), not the tag (`v0.1.6-beta.1`), so a beta package looked like a final 0.1.6. | Supply-chain audit noted the mismatch; the upgrade script looked for `...v0.1.4-beta.6...` and found nothing. | `build-package.mjs` accepts `SEARCH_HUB_VERSION` (release workflow passes the tag); the upgrade script tries both the exact and the bare name. |
| 9 | **The updater fought systemd for the port.** It always spawned its own launcher, so under a `search-hub.service` unit two supervisors competed for the same port and database, and the rollback ended with exit 4 instead of 3. | The real-systemd CI job: `systemctl stop` was followed by the updater starting a second launcher. | The updater detects an installed unit and drives `systemctl stop` / `systemctl start`; `hardStop` is skipped because the unit owns the process and `Restart=on-failure` would undo a direct kill. |
| 10 | **A rolled-back program reported the failed version.** `launcher.json` / `package.json` sit next to `app/`, so restoring only the program left the new version string in place. The post-rollback probe demands the previous version, saw a mismatch, called it "another build is answering" and returned 4 after 1.1 s — while the service was actually up and healthy. | Same job, after #9: `[updater] systemctl start search-hub: ok` then `CRITICAL: rollback did not come up healthy` one second later. | The updater snapshots the manifest bytes before stamping and writes them back as part of the rollback; `updater-test` asserts `package.json` shows the old version again. |
| 11 | **A refused install left the instance down.** `stopService` had already stopped the service, and a failed backup or install returned without starting anything: an update that could not be applied turned into an outage. | Fault case C, once it injected a real failure instead of asserting "something exists". | `recoverPrevious()` restores the previous tree and manifest, starts it and verifies the version: exit 3 when the old version serves again, 4 only when it does not. |
| 12 | **A caller's cancel was recorded as a provider failure.** Cancelling a search in flight produced `searchCalls: 1, successRate: 0, consecutiveFailures: 1` on a source that had never failed, because `runProvider` only recognised `AbortError` / a structured `cancelled` code and classified the common abort-reason path as `unknown`. | New e2e test that aborts a real search mid-flight and reads `/api/admin/health`. | Cancellation is decided by `options.signal.aborted`, and the health summary plus the dashboard's per-provider error count no longer treat `cancelled` rows as traffic evidence about the source. |

## Harness defects worth naming

Two of the tests were green without testing anything. Both are fixed, and the
fixes are what exposed defects #11 and #12.

| Test | Why it proved nothing | Fix |
|---|---|---|
| Fault case H (disk full) | Copied the program onto a 64 KiB tmpfs, but the updater installed into the data directory on the normal filesystem — no ENOSPC was ever reachable, so the assertion passed unconditionally. | `--data` now points at the tiny filesystem, which is where extraction actually happens; asserts the failure is reported, that filesystem's data is byte-identical and the previous version still serves. Tries `sudo -n mount` because a plain runner needs it. |
| Fault case C on Windows | Asserted "exit 0 **or** a file exists", which is true under every outcome. | Holds an open handle inside `app` so the swap fails with real `EBUSY`, then asserts the old version is serving again. |

## What the tests prove

`packaging/launcher/updater-faults.mjs` — 23 assertions on Windows, 27 on Linux
(the Linux run adds case H), all passing locally and in CI:

| Case | Injection | Result |
|---|---|---|
| A | declared size +4 KiB | exit 1 `size_mismatch`, nothing touched |
| B | verified digest over non-archive bytes | 历史 exit 4；v0.1.15 在停服前 exit 1，no swap, no orphan |
| C | open handle inside `app` (Windows) / read-only install root (Linux) | exit 3, previous version serving again |
| D | port held by another process | data intact, failure visible |
| E | new program never listens | exit 3, old program restored, one process |
| F | new program answers 503 | exit 3, rollback |
| G | migration bumps `user_version` to 9, then fails | 历史字节相同；v0.1.15 恢复逻辑数据与 `schema=3`，保留失败 dataDir |
| H | `--data` on a 512 KiB tmpfs (Linux) | failure reported, that filesystem's data unchanged, previous version still serving; skip is printed as a skip, never as a pass |

`packaging/upgrade-matrix.mjs` — in CI, against real published packages:

| Path | Windows | Linux |
|---|---|---|
| `v0.1.4-beta.6` → current | all assertions pass | all assertions pass |
| `v0.1.5-beta.1` → current | all assertions pass | all assertions pass |

Each path verifies the admin session, the provider, an API key that must still
decrypt, search parameters, `master.key` bytes, the database identity, REST,
MCP, and that the catalogue now lists `minimax` / `metaso`.

## What could not be run here

- **Published-asset upgrades** (`v0.1.4-beta.6`, `v0.1.5-beta.1` → current) need a
  network that can fetch 49–74 MB. This machine's proxy truncates at 6–12 MB
  (measured: 11,673,605 bytes for an asset the release lists as 49,356,298).
  The CI job `Cross-version upgrade` does exactly this on `windows-latest` and
  `ubuntu-latest`; its result is the authoritative one.
- **systemd** cannot be exercised on this Windows machine. CI runs it in a
  privileged container whose PID 1 is systemd (`jrei/systemd-ubuntu:24.04`).
- **Disk-full** needs `mount` or `sudo -n mount`. When neither is available the
  case prints a skip and says so; it is never reported as a pass.
