# Update acceptance: real findings

This file records what the cross-version and fault-injection tests actually found.
Every item below was reproduced, then fixed in the same PR.

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

## What the tests prove

`packaging/launcher/updater-faults.mjs` — 22 assertions, all passing locally:

| Case | Injection | Result |
|---|---|---|
| A | declared size +4 KiB | exit 1 `size_mismatch`, nothing touched |
| B | verified digest over non-archive bytes | exit 4, no swap, no orphan |
| C | app directory not writable (Linux) | either a successful update or a runnable old program |
| D | port held by another process | data intact, failure visible |
| E | new program never listens | exit 3, old program restored, one process |
| F | new program answers 503 | exit 3, rollback |
| G | migration bumps `user_version` to 9, then fails | exit 3, **database byte-identical to before** (`schema=3`) |
| H | tmpfs with 64 KiB (Linux) | skipped with an explicit note when mount is not permitted |

`packaging/upgrade-matrix.mjs` — local run against a real package pair, all
assertions passing: admin, provider, API key (still decryptable), search
parameters, `master.key` bytes, old session, REST, MCP, plus the catalogue now
containing `minimax` / `metaso`.

## What could not be run here

- **Published-asset upgrades** (`v0.1.4-beta.6`, `v0.1.5-beta.1` → current) need a
  network that can fetch 49–74 MB. This machine's proxy truncates at 6–12 MB
  (measured: 11,673,605 bytes for an asset the release lists as 49,356,298).
  The CI job `Cross-version upgrade` does exactly this on `windows-latest` and
  `ubuntu-latest`; its result is the authoritative one.
- **systemd** cannot be exercised on this Windows machine. CI runs it in a
  privileged container whose PID 1 is systemd (`jrei/systemd-ubuntu:24.04`).
- **Disk-full** case needs `mount`, which is not permitted here; it reports a
  skip rather than a pass.

None of the three is claimed as passed.
