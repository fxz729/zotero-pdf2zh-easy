# 开发与贡献

用户安装、隐私及服务生命周期边界见 [README](<README.md>)，版本状态见 [CHANGELOG](<CHANGELOG.md>)。请先区分单元测试、构建检查和真实 Zotero 原生验证，不要混用结论。

## 环境与范围

- 开发基线：Node.js 24、Python 3.12、npm。
- 本地使用独立 Python 虚拟环境；不要复用、修改或清理用户的实际 Zotero profile、服务环境或翻译配置。
- Easy 运行时会下载自己的 Python；开发机安装 Python 仅用于运行回归测试，不是终端用户前置条件。
- 首次下载开发依赖需要网络。测试默认使用 mock/合成数据，不应调用付费 API、下载整个翻译引擎或启动用户的服务。

## 安装开发依赖

以下命令是开发说明，不会由打开设置页触发。请在仓库根目录操作。

```sh
cd plugin
npm ci
cd ..
python -m venv .venv
```

macOS / Linux：

```sh
.venv/bin/python -m pip install -r runtime/requirements-server.txt rich
```

Windows PowerShell：

```powershell
.\.venv\Scripts\python.exe -m pip install -r runtime/requirements-server.txt rich
```

单元测试所需依赖采用 [服务端 requirements](<runtime/requirements-server.txt>) 加 Rich，**不安装完整翻译引擎**。不要为运行单元测试安装 [引擎 requirements](<runtime/requirements-engine.txt>) 中的整个依赖集合；真实引擎安装应放在另行授权的隔离验证流程中。

## 测试与构建

Node / 插件回归与构建：

```sh
cd plugin
npm test
npx tsc --noEmit
npm run build
cd ..
```

Python 回归（macOS / Linux）：

```sh
.venv/bin/python -B -m unittest discover -s tests -p "test_*.py" -v
```

Python 回归（Windows PowerShell）：

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p "test_*.py" -v
```

构建产物位置：

```text
plugin/build/pdf-2-zh-easy.xpi
```

`npm test` 中的打包回归及 `npm run build` 会生成被 Git 忽略的运行时公开资源。它们不会安装 Python/翻译引擎，也不应接触用户 profile；但**不是零写入命令**。构建不会自动发布 GitHub Release。

构建末尾已自动执行 [发布审计工具](<scripts/audit_release.py>) 的 archive-only 模式，检查实际 XPI 的身份、更新源、禁止内容及包内运行时清单的原始字节大小/SHA256；不只检查构建前的资源目录。缺少无扩展名 LICENSE、内容不符或含测试驱动时会使构建失败。从插件目录单独运行同一门禁：

```sh
python -B ../scripts/audit_release.py --archive-only --xpi build/pdf-2-zh-easy.xpi
```

需要同时审查 Git 源码清单时，从仓库根目录运行：

```sh
python -B scripts/audit_release.py
```

审计输出为 JSON，只报告安全路径和类别，不回显命中值；这是规则与清单检查，不是对所有凭据泄漏风险的绝对保证。

## v0.1.1 默认值与性能说明约定

- 新安装使用 Next `poolSize=128` / `qps=48`；保留保守 8/4。升级不得向已有用户设置写入新默认值，也不得重置既有质量参数。新增或修改默认值时，分别覆盖新配置与已有配置保持的测试。
- 工作池和 QPS 是上游引擎内部容量上限，不代表 128 个 PDF 同时运行或每秒 48 页。不要把相对 8/4 的配置容量差写成实测耗时加速倍数；服务配额、响应延迟、重试和排版都会影响总耗时，429 时建议回到保守预设。
- 上游基线已包含并发参数，不应描述成串行。翻译、布局、并行能力归上游引擎；Easy 的贡献是预设暴露、默认调优、旧配置保持、服务复用、隐藏启动与无控制台进度采集，不是重写并发引擎。
- reasoning none 和关闭术语表延续已有策略，不是 v0.1.1 新增特性，不承诺没有质量取舍。性能或质量结论必须有单独、可说明边界的验证依据。

## 修改约定

1. 先用失败测试复现，再最小修复，并记录 RED/GREEN 证据。
2. 保持原有引擎版本、翻译 HTTP 协议和高级质量参数；需要改变它们时单独说明理由与迁移影响。
3. 安装或修复必须写全新候选目录，不得原地覆盖活动源码、uv 或虚拟环境；失败不得切换活动指针。
4. 服务启动必须校验身份；只读探测不得创建状态、令牌或锁文件。不要用“端口有响应”代替服务归属验证。
5. 普通安装子进程和需要独立存活的服务进程生命周期不同。修改 Windows 隐藏/Job/breakaway 或 POSIX 进程行为时，补对应边界测试。
6. API Key、Authorization、服务身份令牌和未知高级参数不应出现在日志、异常文本、截图或提交中。只用合成凭据编写回归，并确认真正传给引擎的值没有被脱敏逻辑误改。
7. 不提交个人 API 配置、profile、实际运行环境、翻译结果、文献、日志、下载二进制或密钥。提交差异前人工检查，不能只依赖自动脱敏。
8. 保留上游作者、许可证及第三方依赖的许可证信息，见 [LICENSE](<LICENSE>)。

## CI 做什么、不做什么

[持续集成配置](<.github/workflows/ci.yml>) 将使用 Node 24 / Python 3.12，在 Windows、macOS、Linux runner 上运行自动化回归并构建 XPI、保存构建产物。Python 部分仅安装服务端测试依赖和 Rich，不安装完整翻译引擎。**请以 [GitHub Actions 实时状态](https://github.com/fxz729/zotero-pdf2zh-easy/actions)为准，本文不宣称 CI 已通过。**

0.1.0 的历史本地门禁统计为 Node 126 项、Python 106 项通过，不是 v0.1.1 本次回归结果、远程运行结果或本轮文档编辑重跑的测试。Windows x86_64 / Zotero 10.0.6 的 0.1.0 基线完整原生验收及该版后续包替换核验见 [0.1.0 历史脱敏统计](<docs/verification/windows-0.1.0.json>)。新版证据另见 [0.1.1 验证记录](<docs/verification/windows-0.1.1.json>)，不预填未确定的新包 SHA256 或计数。不能据旧版或截图外推新版实机通过；其他平台、Zotero 版本和复杂文献仍未完成相应原生验收。

CI 权限为 `contents: read`，不引用发布密钥，不创建 Release，不上传更新 feed。它测试的是代码及模拟边界，**不是三平台 Zotero 实机验证**。CI 构建产物也不是自动完成维护者验收的正式发行版。

## 原生验证记录应包含什么

默认先在另行确认的全新隔离 Zotero profile 中验证，不复制真实用户 Key、原版配置、文献或服务令牌。确需真实 API 或本机设置保留性验证时，必须另获明确授权；公开记录仍只能包含脱敏统计。至少记录：

- 操作系统、架构、Zotero 版本、XPI 版本，以及本次验证的明确范围；
- 从无受管环境开始的首次下载、完整性校验、依赖安装、导入检查和候选激活；
- 本地服务就绪后，短命启动 helper 退出后服务是否仍可通过身份校验；
- 真实进程可见性观察、进度卡片及窗口关闭/重开的行为；
- 安装失败、服务忙碌、损坏 marker、身份不匹配时是否保持旧环境和活动指针不变；
- 实际 PDF 翻译及结果导入是否验证，若未验证须明确写出，不能仅凭健康检查推断；
- 所有新建资源及进程的归属和清理情况。不得为了收尾终止未知 PID 或用户原服务。

付费 API 或真实文献测试需要单独明确同意。当前平台结论以 [README 的验证矩阵](<README.md#平台与验证状态>) 为准，不因 CI 变绿就改为“实机通过”。

历史 [Windows 0.1.0 公开记录](<docs/verification/windows-0.1.0.json>) 仅根据维护者提供的统计整理，没有复制原始用户报告、路径、账号、模型/API 配置或令牌。英语原文词覆盖率 1.0 是原文保留指标，不能标为“翻译准确率 100%”。完整原生链条验收绑定基线 SHA256 `ca62849294d28142245a9a2d81bee72f2ac96a66db5ed220ab7f5140880eb3e7`。0.1.0 历史发行包 SHA256 为 `0e926b276a1044321f984875c2728a419c12fe59c2457cf81a73f34107c9d3a4`，相对该版基线仅追加高级连接检查使用 ManagedRuntime、`extraData` 列表仅显示字段数两项前端修复；其证据限于 Zotero 关闭时替换、SHA256 核验、25 个运行时源文件与基线相同及配置未改，未重跑完整原生链条。不得将该版基线用例记录转标为该版后续包或 v0.1.1 完整重测通过。

图源必须明确区分：原两张界面图来自空配置隔离环境，进度图为合成事件；新增三张论文左右双语效果图由用户提供并授权展示，论文版权归原作者及出版方，只展示截图、不附 PDF。不得将效果图当作计时、翻译准确率或跨平台证明，也不能因此放宽个人配置、密钥或未获授权文献的隐私要求。

## 手动发布与更新 feed

发布由维护者人工验收和执行，本 CI 不运行发布命令。`v0.1.1` 附件请从 [发布页](https://github.com/fxz729/zotero-pdf2zh-easy/releases/tag/v0.1.1)获取；若入口不可用，请检查对应发布状态与附件，不根据静态文档推断可用性。发布前检查：

1. XPI 中的插件 ID、版本、命名空间与 [项目元数据](<plugin/package.json>) 一致，且保留上游署名和许可证。
2. [构建配置](<plugin/zotero-plugin.config.ts>) 中更新地址与将要上传的实际 feed 一致。当前稳定 feed 目标为：

   ```text
   https://github.com/fxz729/zotero-pdf2zh-easy/releases/latest/download/update.json
   ```

   测试通道对应 `update-beta.json`；仅配置 URL 不代表附件已经上传或通道已经可用。
3. feed 中的版本、兼容范围和 XPI 下载地址对应实际公开附件。构建后的清单也须复核，不能只看源码模板。
4. 校验 XPI 附件与对应源码、记录校验和，并把平台矩阵更新为**已有证据支持**的状态。未完成真实翻译时明确保留限制。
5. 手动上传 XPI 与更新 feed，并复核版本发布页以及以下 latest 附件入口；不要上传完整运行环境、测试 profile 或原生验证日志中的敏感信息。

   ```text
   https://github.com/fxz729/zotero-pdf2zh-easy/releases/latest/download/pdf-2-zh-easy.xpi
   https://github.com/fxz729/zotero-pdf2zh-easy/releases/latest/download/update.json
   ```

本仓库中的 `npm run release` 不是本 CI 的组成部分；不要在未核对权限、版本和发布对象时执行它。

## 提交问题或贡献

在 [Issues](https://github.com/fxz729/zotero-pdf2zh-easy/issues) 提供最小复现、版本和脱敏诊断；代码变更请附测试与验证范围。若涉及凭据泄漏风险，不要在公开 Issue 中粘贴原值，先移除敏感内容再描述问题。
