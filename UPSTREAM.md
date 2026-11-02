# Upstream and modification notice

This distribution derives from [guaguastandup/zotero-pdf2zh](https://github.com/guaguastandup/zotero-pdf2zh), version 4.1.8, pinned at commit `5dd2eaf019f71266764c269bbd2104b559ae95cf`.

Original author: guaguastandup and upstream contributors. The plugin declares `AGPL-3.0-or-later`; the repository license is preserved verbatim in LICENSE. This derivative will be distributed under the same terms. It is an independent distribution, not an official upstream release.

The initial import includes editable plugin TypeScript, addon assets, Python server source and tests. It excludes the upstream binary PDF manual, audio asset and developer environment example. It never copies the developer's installed runtime, API configuration, logs, translation outputs or Zotero profile. `upstream-manifest.json` records initial imported file hashes; subsequent commits identify modifications.

Planned modifications: guided managed-runtime installation; background process lifecycle; main-window progress card; simplified API preferences; independent distribution metadata and release documentation. Completion and platform validation will be recorded in the release changelog, not inferred from these plans.

PDF2zh Next, BabelDOC, uv and their dependencies remain separate upstream projects. Runtime downloads must retain their licenses and version/source provenance. This repository does not relicense them or claim authorship.
