# Zotero PDF2zh Easy Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans or subagent-driven-development to implement this plan task-by-task.

**Goal:** Deliver a source-buildable cross-platform guided-install Zotero fork, eliminate terminal flashes and native popup borders, and publish a verified Windows release without personal data.

**Architecture:** Keep upstream TypeScript plugin and Python server in plugin/ and server/. Add a managed-runtime module and packaged helper assets, sharing installation status and lifecycle boundaries. Replace only translation progress presentation with a main-window DOM card. Keep local installation untouched until the new distribution passes tests.

**Tech Stack:** Zotero privileged TypeScript, zotero-plugin-scaffold, Node built-in test, Python 3.12 unittest, uv managed environments, AGPL-3.0-or-later upstream.

---

## Task 1: Baseline and provenance

Files: upstream plugin/**, server/**, LICENSE; create UPSTREAM.md, .gitignore, tests/fixtures/synthetic.pdf source generator.

1. Record git upstream HEAD and source tree, inspect package versions/license. Do not copy personal config, translated PDFs, caches, logs or venvs.
2. Copy only upstream editable source plus license into the new project; use upstream defaults after auditing for credentials. Keep upstream snapshot separately.
3. Initialize a new repository (existing installation has no Git repository); add explicit ignores for runtime, logs, build, credentials and PDFs except synthetic fixture.
4. Run baseline `npm ci` then `npm test` and `npm run build` from plugin/. Diagnose any failures before changes. Record baseline counts.
5. Commit audited baseline and approved spec. No remote push yet.

## Task 2: Reproduce silent-process defects

Files: tests/test_silent_process.py; runtime/process.py; server/utils/execute.py; local ensure_server.py only after reproducer.

1. Read all Popen/run call sites and Windows venv pythonw redirector behavior. Inspect visible window PID/process tree read-only; do not restart or interrupt active translations.
2. Write regression tests requiring Windows STARTUPINFO hidden window and CREATE_NO_WINDOW for every console child; POSIX start_new_session without Windows flags. Include argument-array paths with spaces and Unicode.
3. Run unittest and show the tests fail for original process settings.
4. Implement a single shared spawn configuration and apply all relevant subprocess sites; launcher must hide the venv redirector as well as descendant PowerShell/uv/Python calls. Prefer Zotero Subprocess.call with stdout/stderr piping if supported and test it rather than assuming nsIProcess is hidden.
5. Verify tests pass and collect actual window observations during managed test launches. Keep server owner/argv validation intact. Commit.

## Task 3: Main-window progress card

Files: plugin/src/modules/progressCard.ts; plugin/src/modules/pdf2zhHelper.ts; plugin/src/hooks.ts; plugin/tests/progressCard.test.mts; plugin/addon/content/easy.css.

1. Write DOM-adapter tests for one container per main window, escaping text, continuous progress, batch sharing, collapse/expand, completion delay, errors and cleanup. No native progressWindow creation permitted for translation.
2. Run `npm test` expecting missing progressCard export failure.
3. Implement concise card adapter retaining current JobProgressPopup update interface so job logic does not change. Use textContent (no untrusted innerHTML), theme-aware colors, a real progress element, bounded title wrapping, accessible buttons and max height.
4. Remove old private-window sizing/position logic from new fork; attach/dispose with hooks. Ensure DOM is recreated after main window closes/reopens.
5. Run tests/build, inspect in Zotero at different window sizes/themes with synthetic batch. Capture no native progressWindow/no border evidence. Commit.

## Task 4: Managed installation and service runtime

Files: plugin/src/modules/managedRuntime.ts; plugin/addon/content/runtime/**; runtime/bootstrap.py; runtime/service.py; runtime/process.py; runtime/manifest.json; tests/test_runtime.py; plugin/tests/managedRuntime.test.mts.

1. Write tests for OS/architecture selection (win x64, mac arm64/x64, linux x64/arm64 only where pinned assets exist), unsupported combinations, safe user data paths, fixed argument arrays and download origins, partial installs, lock contention and cancellation/error. Fail before implementing.
2. Select immutable uv artifacts, record URLs/hashes/source and licenses, and implement safe extraction (reject traversal/symlink escape). Never pipe a remote shell script into a shell.
3. Plugin installation explicitly asks consent, downloads bounded verified artifacts to staging, invokes fixed bootstrap args, and reports stage/status. Install Python3.12 and pinned requirements into dedicated user runtime. Successful marker written only after imports and service verification. Retry must reuse or repair staging, never delete unrelated paths.
4. Package only needed reviewed server source with plugin assets; derive runtime paths from user data rather than developer paths. Isolate writable config/output from package. Runtime lock prevents duplicate installers/servers.
5. Background readiness after startup and before submission. Bound deadlines and verify owned service via OS identity or per-install secret challenge before documents/API credentials; refuse unexpected port owner. Loopback only. No user secrets in URL or process args.
6. Run Python/Node tests; platform-mocked tests are not real platform certification. Clean Windows runtime installation test records exact dependency resolution and download stages. Commit.

## Task 5: Settings and local migration

Files: plugin/src/modules/easyPreferences.ts; plugin/addon/content/preferences.xhtml; plugin/src/modules/preferenceScript.ts; plugin/addon/prefs.js; plugin/tests/easyPreferences.test.mts; plugin/package.json; plugin/zotero-plugin.config.ts.

1. Read existing preference contracts and LLM config serialization. Write tests for API URL validation, key masking/no-logging, finite positive QPS/concurrency, explicit model, readable failures and preserving unspecified quality settings.
2. Add four native preference groups: service, engine, translation, diagnostics. Connect API form to actual backend config, not a decorative unsaved form. Test connection with bounded request and redact credentials/bodies in errors.
3. New user safe defaults: concurrency8/QPS4; optional high-throughput128/48 preset with rate-limit warning. Existing migration explicitly preserves128/48, deepseek-flash, reasoning none, glossary off and bilingual layout. Do not publish user's endpoint/key. Migration reads locally and writes own preference namespace only after consent.
4. Set independent ID/ref/instance/prefs namespace, fork version and update/repository URLs. Explicitly identify conflicts with upstream ID and guide disabling before activation; no covert uninstall.
5. npm package metadata and lock changes are within approved fork design, keep dependency versions locked and retain attribution. Run test/build; inspect settings screenshot and saved roundtrip without exposing key. Commit.

## Task 6: Preserve headless progress and complete integration

Files: server/utils/execute.py; plugin/src/modules/pdf2zhHelper.ts; tests/test_headless_progress.py; tests/integration/**.

1. Port only tested local pipe capture/progress width200 patches to editable server source; compare exact functions to local working execute.py, do not copy private runtime files.
2. Run inherited9progress/4popup/adapted59 regression expectations, updating native-popup tests to card contract without weakening progress/import assertions.
3. Confirm no active translations; back up addon and non-secret migration metadata; install fork through Zotero native addon APIs, disable upstream only with documented restore path. Restart only when needed, never kill user work.
4. Watch windows during ordinary Zotero startup, service recovery and synthetic one-page translation. Verify no terminal flashes, one card, smooth progress and valid bilingual PDF imported/openable. Record any external rename repair separately; don't claim flawless automatic import if repaired.
5. Re-run all suites and inspect final diff. Commit.

## Task 7: Security review, documentation and publishing

Files: README.md, UPSTREAM.md, CHANGELOG.md, .github/workflows/**, scripts/package.py, scripts/audit_release.py, dist/*.

1. Write build and first-install instructions, provider privacy warning, licenses, supported matrix (Windows tested; mac/Linux untested), model/quotas, failure recovery, uninstall and migration restore.
2. Build XPI from source, inspect archive whitelist and scan both Git index and archive for private paths/emails/API keys, config/logs/PDF contents. Report potential hits without printing secrets.
3. Independent review checks executable download trust, local service authentication, input validation, key storage/logging, installer repair and no credentials in artifacts. Fix security issues before publish.
4. Verify actual GitHub authenticated account. `gh api user --jq .login` currently reports fxz729; reconcile with MCP authorization before writes. Create public zotero-pdf2zh-easy in the authorized account (user explicitly approved name/publication); no force pushes.
5. Push reviewed source, create tagged release with XPI/checksums via authorized GitHub interface, verify remote README, commit and download checksum. Do not claim a release is downloadable based only on local build.
6. Final report links repository/install artifact, Windows evidence, cross-platform limitations and required first-install action. Mark goal complete only after the entire acceptance set is satisfied.

## Execution

Proceed in this same session as user requested turn-key delivery; independent read-only audits may run in parallel, implementation scopes must not overlap. If subagent backend fails, Lead performs the required work directly rather than treating an absent review as approval. Stop at genuinely required user consent boundaries, not after each implementation detail.
