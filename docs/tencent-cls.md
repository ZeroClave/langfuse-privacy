# 腾讯云 CLS／AgentObs 接入

这个示例复用 `@zeroclave/langfuse-privacy` 的 `mask`，将处理后的 Agent Trace 通过标准 OTLP/HTTP 发往腾讯云 CLS／AgentObs。无需部署 Langfuse Server，也无需 Langfuse 项目或密钥。

```text
合成客服样例
  → LangfuseSpanProcessor 的 mask
  → ZeroClave HTTPS 检测 → 应用内替换
  → 同一 processor 的 CLS OTLP exporter
  → CLS 存储 → SearchLog 读回核验
```

**ZeroClave 托管检测服务会收到原文。** 替换发生在应用进程内，CLS 收到经过 hook 处理的字段。本地／私有部署仍在计划中；这个示例不提供“原文不出客户环境”的保证，也不修改实际发给模型的请求。

当前真实 CLS 写入和读回仍待配置腾讯云测试项目后验证。没有腾讯云凭证时，可以先运行下方的本地测试或“真实检测＋本地接收器”测试；它们不会宣称已经写入腾讯云。

## 准备自己的 CLS 测试项目

1. 准备 Node.js 22 或 24，并克隆本仓库。
2. 开通腾讯云日志服务，在 **CLS 控制台 → Agent 可观测 → 应用接入** 创建测试应用，取得地域和 Trace 日志主题 ID。请使用日志主题 ID，不能填写应用 ID。
3. 准备对该主题有写入和检索权限的 CAM 凭证。上报需要目标主题的 `cls:pushLog` 权限；本示例还调用 `SearchLog` 读回，需要 `cls:SearchLog` 检索权限。只具有写入权限时，不能完成这个示例的验收。[腾讯官方权限示例](https://cloud.tencent.com/document/product/614/118699)列出了该检索动作，请按测试主题限制授权范围。

示例不会创建云资源或自动扩大权限。资源与访问方式以腾讯官方的 [Langfuse SDK 接入文档](https://cloud.tencent.com/document/product/614/133518)和 [SearchLog API 文档](https://cloud.tencent.com/document/api/614/56447)为准。正常使用 CLS 可能产生云服务费用。

## 配置与运行

在仓库根目录执行：

```sh
npm ci --ignore-scripts
cp examples/tencent-cls/.env.example .env.cls
```

在自己的编辑器中填写 `.env.cls`。它被 Git 忽略，与浏览器 Langfuse 演示使用的 `.env` 分开。运行入口读取仓库根目录的 `.env.cls`，进程中已有的环境变量优先，不会被文件覆盖。不要把包含密钥的配置文件、终端截图或云端原始返回提交到 GitHub。

| 变量 | 含义 |
| --- | --- |
| `CLS_DEFAULT_REGION` | Trace 主题所在地域，例如 `ap-guangzhou`。 |
| `CLS_TOPIC_ID` | 测试应用的 Trace 日志主题 ID。 |
| `TENCENTCLOUD_SECRET_ID` | CAM 访问凭证的 SecretId。 |
| `TENCENTCLOUD_SECRET_KEY` | 与 SecretId 配套的 SecretKey。 |
| `TENCENTCLOUD_TOKEN` | STS 临时凭证的 Token；长期密钥不填写。 |
| `CLS_MAX_CONCURRENT_MASKS` | 可选，单个示例 processor 同时进行的 mask 回调上限，默认 `4`，范围 `1–32`。满额时不排队，安全屏蔽对应整个字段。 |
| `CLS_READBACK_TIMEOUT_MS` | 可选，等待本次 CLS 记录可检索的预算，默认 `60000`，范围 `1–60000` 毫秒。 |
| `ZEROCLAVE_ENDPOINT` | 可选，默认 `https://zeroclave.com/v1/pii/detect`。 |
| `ZEROCLAVE_TIMEOUT_MS` | 可选，单次 mask 回调的检测预算，默认 `15000`，范围 `1–60000` 毫秒；它不是整次运行的总预算。 |

运行命令行演示：

```sh
npm run demo:cls
```

也可以使用真实服务验收命令：

```sh
npm run test:cls:live
```

两个命令使用相同的真实服务验证入口，都会将内置合成文本发送给 ZeroClave，并向自己的 CLS 测试主题写入 Trace，再调用 SearchLog 核验。它们不启动网页、不调用大模型，也不发送真实客户数据。

**缺少配置会以非零状态退出，不会跳过云端验收后返回“通过”。** 请只使用为测试准备的日志主题和凭证。

运行结果写入被 Git 忽略的 `.local/cls-live-test-report.json`。真实云端成功时，报告包含 `mode: "cls-cloud"`、`passed: true`、`cloudPersisted: true`、本次 Trace／Span ID、检查结果和经过核验的读回字段；失败时记录固定失败码，`cloudPersisted` 为 `false`。报告也可能包含主题 ID 等项目标识，对外分享前先检查内容。

## 怎样判断真的收集成功

脚本的成功条件包含整个链路：

1. ZeroClave 完整返回，支持字段中的预期合成敏感值已被替换。
2. 真实 OTLP exporter 向配置的 CLS 接收端上报。
3. SearchLog 查询到与本次 Trace／Span 对应的记录。
4. 从 CLS 读回的内容保留预期的上下文、JSON 结构和普通值，且不再包含预期合成敏感值；整字段失败掩码不算健康路径成功。

HTTP 上报成功、在本地看到替换后的文本、只查询到同名的旧 Trace，都不能代替这次读回核验。检测服务返回的实体类型可能变化，不能通过某一个固定的 `NAME` 或 `EMAIL` 标签推断一般识别率。

SearchLog 通过官方 SDK 调用，单次请求超时为 10 秒。总轮询预算结束后停止等待结果，但不保证取消已发出的 SDK 请求。读回按[腾讯的 Langfuse 字段说明](https://cloud.tencent.com/document/product/614/139918)检查 `attribute` 中的输入、输出与 metadata，兼容字段里的 JSON 编码。

需要人工查看时，打开 **CLS 控制台 → Agent 可观测**，进入测试应用的调用链，选择本次运行的时间范围和 Trace ID，检查对应节点的输入输出及 metadata。终端和报告中的 Trace ID 用于定位这次记录；普通日志主题里的历史数据不代表本次接入成功。

## 在现有应用中组合

沿用腾讯官方示例配置 CLS 的 `OTLPTraceExporter`，然后将它与 ZeroClave `mask` 放在同一个处理器里：

```ts
new LangfuseSpanProcessor({
  mask: createZeroClaveMask(),
  exporter: clsExporter,
  mediaUploadEnabled: false,
});
```

这里的 `clsExporter` 是已配置 CLS 地址、鉴权和日志主题的 exporter，代码只展示组合关系。可运行入口在 [examples/tencent-cls/run.mjs](../examples/tencent-cls/run.mjs)，[cls.mjs](../examples/tencent-cls/cls.mjs) 封装地址、凭证和并发限制。直接复制上方最小片段不会自动获得示例层的并发限制。应用已有 OpenTelemetry 初始化时，修改现有处理器，避免重复初始化 SDK。

上报地址为 `https://{CLS_DEFAULT_REGION}.cls.tencentcs.com/v1/traces`，主题通过 `topic_id` header 指定。官方 Basic 鉴权格式为：

- 长期凭证：对 `SecretId:SecretKey` 做 Base64 编码。
- STS 临时凭证：对 `TmpSecretId#Token:TmpSecretKey` 做 Base64 编码。

这些凭证用于 CLS exporter，不能放进 Trace 输入、输出或 metadata，也不应传给检测服务。示例不会把 CLS 凭证当作检测 API 的鉴权信息。

**不要另加一个未经处理的 exporter 来实现旁路投递。** 当前 SDK 的 mask 是异步步骤；另一个 processor 可能在替换完成前导出原始 span。需要多个目的地时，应先设计统一处理后的分发路径，并单独测试每个出口。

## 失败行为与覆盖边界

在锁定的 `@langfuse/otel` 6.1.1 中，检测超时、`partial`、无效实体范围等错误会让对应整个字段成为失败掩码；示例不会退回原文。真实服务验收命令遇到检测失败或读回失败会退出非零，不会把失败掩码当作正常脱敏成果。

示例在 mask 入口限制并发检测数量，默认最多 `4` 个回调。达到限制时抛出固定错误，由已测试的 Langfuse SDK 安全屏蔽对应整个字段，不建立等待检测的原文队列，也不将原文上报。这个限制属于单个示例 processor；它不协调多个进程或多台机器。该取舍会减少排障上下文；生产接入还需要按实际流量验证检测限额、队列与导出预算，以及退出时的 flush 行为。

该适配只覆盖 Langfuse hook 触达的 trace／observation input、output 和 observation metadata 中的字符串值，包括其嵌套 JSON。以下内容需要另行处理：

- span 名称、ID、event、resource attributes、其他属性及部分传播 metadata。
- 对象键名、数字、布尔值、媒体与二进制数据。
- 应用的 `console`、文件日志、异常堆栈、其他 processor 或 exporter。
- 真正发送给模型的请求、业务数据库和其他存储。

因此，这个示例是 **Agent Trace 接入**，不能宣称整个应用或普通业务日志已统一脱敏。不要把敏感值放进已知不受保护的字段。检测完整返回也不保证没有漏检；初次验收应使用合成样例。

## 三层测试与云端证据

```sh
npm run check
npm run test:cls
```

`check` 包括仓库类型检查及全部自动测试；`test:cls` 单独运行 CLS 相关测试。自动测试使用 mock 检测响应、真实 OTLP protobuf HTTP exporter 和本地接收器，并通过 SearchLog 形状的响应验证读回解析、分页及本次记录匹配。还覆盖鉴权与主题配置、检测失败时的整字段掩码、并发满额行为、上报拒绝和未覆盖字段边界。它们不调用腾讯云或真实 ZeroClave 服务，不证明自己的 CLS 账号、权限、索引或云端读回可用。

没有腾讯云凭证时，可单独验证真实检测与网络导出链路：

```sh
npm run test:cls:transport:live
```

该命令向真实 ZeroClave 发送内置合成文本，经真实 protobuf HTTP exporter 发往本机接收器，并核验从本机接收器读回的记录。它使用本地合成凭证，不需要腾讯云账号，也不连接 CLS。检测地址和单次回调预算可由进程环境变量 `ZEROCLAVE_ENDPOINT`、`ZEROCLAVE_TIMEOUT_MS` 指定。

结果保存到 `.local/cls-transport-live-report.json`，成功时 `mode` 为 `real-detector-local-collector`，**`cloudPersisted` 仍为 `false`**。即使报告中 `passed` 和 `persisted` 为 `true`，也只代表本地接收器收到了经过验证的内容，不能作为腾讯云入库证据。默认自动测试和 CI 不运行这个真实检测命令。

`npm run test:cls:live` 才会访问两个真实服务，需要自己配置 CLS。它与默认测试和 CI 分开执行；成功需要当次 CLS 读回证据。项目现有的 `npm run test:live` 只验证真实 ZeroClave 与内存 exporter，不向 CLS 上报。

| 命令 | 检测端 | 接收与读回端 | 可以证明什么 |
| --- | --- | --- | --- |
| `npm run test:cls` | Mock | 本地 protobuf HTTP 接收器与 SearchLog 响应 fixture | 已测试的协议、替换和失败路径。 |
| `npm run test:cls:transport:live` | 真实 ZeroClave | 本地 protobuf HTTP 接收器 | 合成样例的真实检测与网络传输，`cloudPersisted: false`。 |
| `npm run test:cls:live` 或 `npm run demo:cls` | 真实 ZeroClave | 真实 CLS 与 SearchLog | 只有本次记录成功读回并通过检查，才报告 `cloudPersisted: true`。 |

仓库锁定 `@langfuse/otel` 6.1.1、`@opentelemetry/exporter-trace-otlp-proto` 0.223.2 与 `tencentcloud-sdk-nodejs-cls` 4.1.344。腾讯官方 SDK 用于示例的 SearchLog 签名与调用，属于开发依赖；发布的 ZeroClave 适配包仍无运行时依赖。

## 排查接入失败

| 现象 | 检查项 |
| --- | --- |
| 启动时配置不完整 | `.env.cls` 是否在仓库根目录；必填变量是否填写。 |
| CLS 拒绝上报 | 主题与地域是否一致、凭证是否有效、临时凭证是否包含 Token、是否具备目标主题写入权限。 |
| 已上报但 SearchLog 失败 | 检索权限、目标主题、索引与服务返回状态；不能仅凭上报成功通过验收。 |
| SearchLog 暂未读到本次记录 | 核对本次 Trace ID、时间范围、主题和索引；CLS 写入后可能存在可检索延迟。 |
| 检测失败或整字段掩码 | 检查 ZeroClave 网络、请求预算、限流与返回的固定错误码；不要增加原文兜底。 |
| 预期合成敏感值仍存在 | 检查字段是否在 hook 覆盖范围、检测是否完整、实体召回与偏移；测试应失败。 |

对外反馈时只提供脱敏后的诊断信息和必要的固定错误码，先移除密钥和云账号信息。不要通过公开 issue 上传真实用户 Trace。

本示例由 ZeroClave 维护，是基于公开协议的社区接入，不代表腾讯云官方合作或认证。
