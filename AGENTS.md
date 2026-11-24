# AGENTS.md

Rules for any agent working in this repository.

## Continuous Autonomous Delivery

Within a development task the repository owner has explicitly assigned, an agent
must carry the work through to a real, verified release on its own.

Finishing a phase is not finishing the task. Normal PR merges, version bumps,
Tag creation and Release publication are pre-authorized for assigned tasks; do
not stop to ask for approval at each stage.

The standard completion path for every assigned task is:

```
develop → test → PR → required checks → normal merge → verify final SHA
        → build → cross-platform acceptance → Release → final report
```

When a step fails, keep the evidence, find the root cause, and retry. Do not skip
a safety or quality gate to make the pipeline green.

A serious security defect must be fixed before release, never deferred to a
follow-up version.

Stop and report only when all self-executable work is done, or when a genuine
blocker cannot be removed from inside the repository (missing credentials, an
external permission the owner must grant, or an operation that would be
destructive). Authorization boundaries stay in force for those.

Do not end an assigned version's work by claiming "partially complete".

## What is pre-authorized for assigned tasks

- Editing code, tests, docs and workflows in this repository
- Creating development branches, committing locally, pushing normally
- Opening and updating Pull Requests
- Running CI and fixing failures it surfaces
- Merging a PR once every required check passes
- Bumping the version, creating a **new** Tag, publishing a Release
- Uploading Windows/Linux packages and `SHA256SUMS`
- Building and publishing a verified GHCR image
- Updating README / CHANGELOG
- Reporting the result

This covers this repository only. It never extends to other repositories,
servers, or accounts.

## Absolute prohibitions

Even with release authorization, never:

- bypass branch protection, or use admin bypass to merge
- force-push or rewrite published history
- overwrite, move or delete an existing Tag
- publish a Release that points at a SHA other than the Tag's own commit
- fake test results, or delete a failing test to turn CI green
- claim a platform works when its acceptance failed
- present a beta as a stable release
- use production API keys without authorization, or spend money on paid APIs
  of unknown amount
- delete production databases or user data
- change repository visibility or weaken security policy

If GitHub permissions or branch protection genuinely block an operation, record
the blocker and continue with everything else that is still executable. Never
work around it.

## Resource safety for coding and verification

Before running large-scale tests, builds, or spawning parallel sub-agents, every
agent MUST first inspect the host's current available physical memory (当前可用物理内存).
Do not substitute total RAM, Node heap, or a stale observation. When resources
are insufficient, dynamically adjust scheduling and concurrency (动态调整调度/并发);
do not skip tests, narrow their scope, weaken assertions, increase timeouts to
hide failures, or lower standards (不得跳测试/降低标准).

A single OOM must not automatically be attributed to a product memory leak
(不得把单次 OOM 自动归因产品泄漏). Preserve exit codes, logs, process-tree
identity, cgroup events, and V8/native evidence, then classify the root cause.
Only confirmed OOM may trigger the documented one-time concurrency reduction.

Never clean user caches or workspaces without evidence and explicit authorization
(不得无证据清理用户缓存/工作区). Resource tools may clean only owned process
trees with revalidated PID/start-time/ancestry. `git clean -fdx` is prohibited as
a cleanup shortcut. Do not kill user processes, restart the host, or modify
Swap/pagefile, Docker, or WSL configuration.

Every formal release must leave a same SHA resource record (每次正式版本发布留资源记录)
under `artifacts/<version>/`, including real platform results and verification
verdicts. `verify:smart` and local lowmem runs never replace full CI coverage.

## Release requirements

- Only a `main` commit that passed the required checks may be released.
- A Release must be built from the exact SHA the Tag points at.
- Re-running a release for the same version must not create a duplicate or an
  inconsistent Release; it must fail loudly instead.
- A failed build must never produce a successful-looking Release.
- Record the real verification result per platform (Windows, Linux, Docker)
  separately. Do not average them into one claim.
- Publish `SHA256SUMS` and verify every asset after upload.
- Release notes must list the real changes and the known limitations.
- Keep previous versions and their Release records intact. Marking an old
  release as superseded is allowed and encouraged; deleting it is not.

## When a release counts as done

A version is released only when all of the following are true:

1. every required check on the released SHA is green;
2. each platform package was built on real hardware for that platform and passed
   the packaged-binary acceptance (not just "it compiles");
3. the uploaded assets were downloaded again and their checksums verified;
4. the Release URL and per-platform results are reported to the owner.

If a platform's acceptance fails, that platform is reported as unavailable and
the release is either fixed and re-run, or the gap is stated explicitly.
