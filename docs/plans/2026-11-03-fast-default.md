# v0.1.1 高吞吐默认与效果预览实施计划

**Goal:** 按用户已确认方案发行新安装默认 128/48 的 v0.1.1，并公开三张指定截图及有依据的性能说明。

**Architecture:** 仅修改默认偏好和设置页空值展示；保留已保存值及 8/4 预设。插件版本与未变的运行时版本分开验证，保留旧发行物。

**Tech Stack:** Zotero、TypeScript、Node 测试、Python unittest、GitHub CLI、PNG。

## 1. 默认与版本回归（Lead）

修改 plugin/tests/easySettingsModel.test.mts 的新用户默认断言为 128/48；增加 plugin/tests/easyPreferences.test.mts 验证空值显示与已有保守参数不被写入、明确提示风险。更新 distributionIdentity.test.mts 对 0.1.1 的断言，以及 tests/test_release_audit.py 中插件 0.1.1 / runtime 0.1.0 的合成夹具。

运行 `node --experimental-strip-types --test tests/easySettingsModel.test.mts tests/easyPreferences.test.mts tests/distributionIdentity.test.mts`（plugin 目录），确认失败原因是旧默认值/旧版本。再修改 plugin/addon/prefs.js 的 poolSize=128、qps=48；easyPreferences.ts 空值显示与提示；package.json/package-lock.json 根版本；audit_release.py 分离 VERSION=0.1.1 和 RUNTIME_VERSION=0.1.0。复跑直到通过，不改依赖、引擎或已保存值。

## 2. 原图与文档（并行）

Lead 核对三张会话附件原始 SHA 并转换为无元数据 PNG，分别写入 docs/images/translation-bilingual-page.png、translation-conceptual-framework.png、translation-study-table.png。文档队友仅修改 README.md、CHANGELOG.md、CONTRIBUTING.md，说明上游贡献、并发/QPS 含义、API 配额风险和截图边界。

## 3. 门禁与发行（Lead）

`npm test`、`npm run build`；使用隔离测试 Python 执行 `-B -m unittest discover -s tests -p "test_*.py"`。检查实际 XPI 默认偏好、两更新 feed 的 SHA512、25 个运行时源文件与 0.1.0 相同；生成 SHA256SUMS，写 docs/verification/windows-0.1.1.json（明确未执行新版原生验收）。执行 `python -B scripts/audit_release.py`、`git diff --check`，只提交相关公开文件。

先推 main，再以对应提交发布 v0.1.1 和四个附件；不覆盖 v0.1.0。匿名下载校验与本地字节一致。只交付已确认事实，注明远程 CI 如仍受账单锁定则未执行、macOS/Linux 未原生验证。
