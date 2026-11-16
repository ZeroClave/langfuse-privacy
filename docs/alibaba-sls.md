# 阿里云 SLS／普通 LogStore 接入

这个示例把普通 JSON 业务日志显式交给 `createZeroClaveMask` 处理，再通过阿里云官方 SLS SDK 写入普通 LogStore。应用负责选择提交哪些字段，并在检测成功后才调用写入接口。

```text
合成 JSON 业务日志
  → createZeroClaveMask
  → ZeroClave HTTPS 检测 → 应用进程内替换
  → 官方 SLS SDK 写入普通 LogStore
  → GetLogs 按唯一 runId 查询 → 核验本次存储内容
```

不需要 Langfuse Server、Langfuse 项目或大模型调用。它不使用 SLS OTLP Trace、SessionStore，也不是给 LoongCollector 安装插件后自动处理整个应用日志的方案。已有其他日志出口时，需要在各自写入前接入并验证脱敏。

**ZeroClave 托管检测服务会收到原文。** 替换发生在应用进程内；本地／私有部署仍在计划中，这个示例不保证“原文不出客户环境”。示例使用内置合成数据，不应改成真实客户日志进行首次验收。

真实 SLS 写入和读回仍待配置阿里云测试项目后验收。本地测试和真实检测加本地接收器测试各有独立证据范围，不能作为阿里云已入库的证明。

## 准备测试项目

1. 准备 Node.js 22 或 24，克隆本仓库。示例代码在 [examples/alibaba-sls/](../examples/alibaba-sls/)；它不随当前 npm 包发布，也没有 `@zeroclave/langfuse-privacy/sls` 导出。
2. 在 SLS 控制台创建或选择专用测试 Project，并在其中创建普通日志 LogStore。记录 Project 名称、LogStore 名称及所在地域。不要填 Trace 应用 ID 或 SessionStore 名称。
3. 在 **LogStore → 查询与分析 → 索引属性** 配置下表索引，保存后等待约一分钟，再运行脚本写入新日志。索引修改只应用于生效后新写入的数据；先写日志再建索引，不能保证旧日志可查询。[阿里云索引说明](https://www.alibabacloud.com/help/en/sls/create-indexes)
4. 准备具有该测试资源写入和检索权限的 RAM 用户或 STS 临时凭证。示例不会创建资源、修改索引或扩大权限。

| 索引 | 建议配置 | 用途 |
| --- | --- | --- |
| 全文索引 | 开启；按业务需要配置分词。 | 在控制台查看日志上下文。仅配置全文索引不足以支持本示例的 `runId:...` 字段查询。 |
| `runId` 字段索引 | `text`；分词符留空；开启大小写敏感；无需开启统计分析。 | 让唯一运行 ID 作为一个完整词检索，随后由脚本对读回字段做精确相等检查。 |

本示例实际调用的写入与检索动作分别对应 `log:PostLogStoreLogs`、`log:GetLogStoreLogs`。按[阿里云 RAM 权限文档](https://help.aliyun.com/en/sls/log-service-ram-access-control-permissions-configuration)或控制台权限助手，将策略限制到目标 Project 和 LogStore；资源格式为 `acs:log:<region>:<account-id>:project/<project>/logstore/<logstore>`。账号策略、显式拒绝及控制台操作可能影响实际权限，最终需要在自己的测试项目验证；不要直接给示例授予全部日志服务管理权限。

在 **Project 概览 → 访问域名** 核对地域，例如杭州公网 endpoint 为 `cn-hangzhou.log.aliyuncs.com`。示例从 `SLS_REGION` 构造官方公网 endpoint，通过 HTTPS 访问 SLS，没有 `SLS_ENDPOINT` 覆盖项；请确保当前网络可访问该公网域名。生产环境如需内网或其他接入域名，应另行配置并测试 SDK。[阿里云 endpoint 说明](https://help.aliyun.com/en/sls/developer-reference/service-entrance)

## 配置与运行

在仓库根目录执行：

```sh
npm ci --ignore-scripts
cp examples/alibaba-sls/.env.example .env.sls
```

在自己的编辑器中填写 `.env.sls`，不要将密钥粘贴到聊天、日志或 issue。此文件被 Git 忽略，与 Langfuse 演示的 `.env` 以及 CLS 的 `.env.cls` 分开。运行入口读取仓库根目录的 `.env.sls`，已有进程环境变量优先。

| 变量 | 含义 |
| --- | --- |
| `SLS_REGION` | 必填，Project 所在地域，例如 `cn-hangzhou`。 |
| `SLS_PROJECT` | 必填，专用测试 Project 名称。 |
| `SLS_LOGSTORE` | 必填，普通日志 LogStore 名称。 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 必填，RAM 或 STS 的 AccessKey ID。 |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 必填，对应的 AccessKey Secret。 |
| `ALIBABA_CLOUD_SECURITY_TOKEN` | STS 的 SecurityToken；长期 RAM 密钥不填写。 |
| `SLS_MAX_CONCURRENT_MASKS` | 可选，单个 writer 同时处理的日志数上限，覆盖检测及 SDK 写入时段；默认 `4`，范围 `1–32`。满额时拒绝本次日志，不排队或写入原文。 |
| `SLS_READBACK_TIMEOUT_MS` | 可选，等待本次日志可查询的预算，默认 `60000`，范围 `1–300000` 毫秒。 |
| `ZEROCLAVE_ENDPOINT` | 可选，默认 `https://zeroclave.com/v1/pii/detect`。 |
| `ZEROCLAVE_TIMEOUT_MS` | 可选，单次 mask 调用的检测预算，默认 `15000`，范围 `1–60000` 毫秒；示例不重试检测，不是整次云端验收预算。 |

配置项以 [examples/alibaba-sls/.env.example](../examples/alibaba-sls/.env.example) 为准。长期凭证使用 RAM AccessKey；使用 STS 时，需要同时提供配套的临时 AccessKey ID、AccessKey Secret 和 SecurityToken。临时凭证到期后需更新；示例不会自动 AssumeRole 或刷新凭证。[阿里云 STS 说明](https://help.aliyun.com/en/sls/developer-reference/use-sts-to-enable-cross-account-access-to-log-service-resources)

完成索引及配置后运行：

```sh
npm run demo:sls
# 相同的真实服务验收入口：
npm run test:sls:live
```

这两个命令使用真实 ZeroClave 检测服务和自己的 SLS 测试 LogStore。缺少配置、检测失败、上报失败或读回无法核验时，命令均应非零退出；不会把缺少凭证当作通过。正常使用 SLS 可能产生云服务费用。

云端结果保存到 `.local/sls-live-test-report.json`。只有本次读回通过时，才有 `mode: "sls-cloud"`、`passed: true`、`persisted: true`、`cloudPersisted: true`；报告同时记录 `runId`、目标资源、检查项及核验后的存储内容。失败记录固定错误码，不输出检测原文或云 SDK 原始异常。

官方 SDK 的调试输出可能包含请求凭证信息，运行入口会拒绝非空 `DEBUG` 环境变量；如启动时因此失败，先取消 `DEBUG` 后再运行。不要为排查问题开启云 SDK 原始请求日志。

## 怎样确认本次日志已收集

验收需要完成以下链路：

1. 检测完整返回，合成样例中的预期敏感值已消失，普通上下文、嵌套 JSON 和非文本值保持预期结构。
2. 官方 SDK 向配置的普通 LogStore 写入经过处理的日志。
3. GetLogs 在本次时间范围内按唯一 `runId` 查询；读回记录的 `runId` 必须与本次运行精确相等。
4. 从读回内容重新核验预期合成敏感值已消失、应保留的上下文与结构仍在。检测失败后的丢弃或整字段屏蔽不能算健康路径成功。

只在终端看到替换后文本、收到写入 HTTP 成功，或者查询到一次旧日志，都不等于本次读回通过。`runId` 是随机测试标识，不应放手机号、邮箱或其他个人标识。匹配的读回记录证明这条日志的存储结果，不证明整个 LogStore 的历史记录或全应用所有日志都已处理。

读回只接受 `x-log-progress: Complete` 的查询结果，并检查各页；不完整结果会在预算内重新查询，状态缺失或格式异常会失败，不会因为部分结果中恰好出现本次 ID 就报告成功。

SLS 写入后可能有可检索延迟；预算内未读到本次记录时验收失败。手工查看可打开该 LogStore 的 **查询与分析**，选择本次时间范围，搜索 `runId:"<本次运行ID>"`，展开匹配日志检查内容。若索引生效晚于这次写入，请在索引生效后重新运行，而不是用旧日志冒充成功。

本示例通过所选官方 Node SDK 的 `getLogs` 方法读回。阿里云当前 API 文档已将 [GetLogs](https://www.alibabacloud.com/help/en/sls/developer-reference/api-sls-2020-12-30-getlogs) 标为弃用并推荐 GetLogsV2；此仓库保留已测试 SDK 的读取路径，后续升级需重新验证响应格式和查询完成状态。

## 在现有业务日志中接入

核心顺序如下：

```ts
import { createZeroClaveMask } from '@zeroclave/langfuse-privacy';

const mask = createZeroClaveMask();
const masked = await mask({ data: businessLog });
// 仅在上一步成功后，将 masked 转成所选 SDK 要求的日志字段并写入 SLS。
```

该片段只展示调用顺序，不是完整日志框架。可运行示例在 [run.mjs](../examples/alibaba-sls/run.mjs)，SDK 写入封装在 [sls.mjs](../examples/alibaba-sls/sls.mjs)，读回核验在 [readback.mjs](../examples/alibaba-sls/readback.mjs)。沿用业务应用现有的日志路径，明确选择待处理内容，再把结果交给云 SDK；不要在异常分支把原始 `businessLog` 交给另一个 logger 或 exporter。

## 失败行为与覆盖范围

直接调用 `createZeroClaveMask` 时，超时、限流重试耗尽、`partial`、无效范围、缺少结果等会抛出 `ZeroClavePrivacyError`。没有 Langfuse processor 替业务处理异常；应用必须等待处理成功再写日志，失败时丢弃或按业务策略整字段屏蔽，不能返回原文重试写入。**本示例选择拒绝整条日志：检测失败或 writer 处理上限满额时，不调用 SLS 写入接口。** 只记录固定错误码，不输出异常中的原始日志。

示例对 `input`、`output`、`metadata` 的字符串递归处理，处理结果作为 JSON 存在 SLS 的 `payload` 字段；`runId` 为随机的 32 位十六进制标识，`service` 和 `schemaVersion` 使用固定非敏感值。适配业务时，不要将真实身份数据放到这些定位字段或静态元数据中。并发限制只作用于单个 writer，不协调其他进程；生产容量和丢弃策略需要按实际流量验证。

覆盖范围是**显式传入 mask 的 JSON 值中的字符串**，包括嵌套对象、数组和可解析的 JSON 字符串；它不会自动拦截 `console`、文件日志、异常堆栈或其他 SDK。以下内容仍需应用自行处理：

- 对象键、数字和布尔值；敏感编号、手机号应保存为字符串，不能放在键名中。
- 未传入 mask 的字段、SLS `source`／`topic`／标签、Project 和 LogStore 名称、访问凭证及请求元数据。
- 图片、音视频、二进制、业务数据库以及真正发送给模型的请求。

JSON 字符串会解析后重新序列化，空白和重复键可能变化。超出适配器限制或不支持的输入会失败，不会静默截断后继续写入。通用选项、输入上限及类型限制见 [README 的配置与隐私范围](../README.md#configuration)。检测状态为完整不等于没有漏检，合成样例通过也不是检测准确率、延迟或吞吐基准。

## 三层测试与证据范围

```sh
npm run test:sls
npm run test:sls:transport:live
```

| 命令 | 检测服务 | 写入与读回端 | 证据范围 |
| --- | --- | --- | --- |
| `npm run test:sls` | Mock | 本地 SLS 接收器及 GetLogs fixture | 已测试的 SDK 请求、替换、读回解析和失败路径；不访问真实服务。 |
| `npm run test:sls:transport:live` | 真实 ZeroClave | 本地 SLS 接收器 | 合成样例的真实检测与 SDK 网络传输；`cloudPersisted: false`。 |
| `npm run test:sls:live` 或 `npm run demo:sls` | 真实 ZeroClave | 真实 SLS 与 GetLogs | 只有本次日志读回核验通过后才报告 `cloudPersisted: true`。 |

本地 SLS fixture 使用真实官方 SDK 编码 protobuf、生成 V1／STS 签名并发出 HTTP 请求，由本地接收器独立解码、核验合成签名并返回 GetLogs 形状的内容。loopback 测试为访问本机省略生产环境中的 Project DNS 前缀；该协议验证不连接阿里云，也不证明真实云端鉴权可用。

真实检测加本地接收器的脚本为 [scripts/test-sls-transport-live.mjs](../scripts/test-sls-transport-live.mjs)，报告保存在 `.local/sls-transport-live-report.json`，`mode` 为 `real-detector-local-collector`。即使有 `passed: true` 和 `persisted: true`，`cloudPersisted` 仍为 `false`，只能说明本地接收器收到并读回了经过核验的合成日志。

真实服务命令与默认自动测试、CI 分开。`npm run check` 运行仓库类型检查与自动测试；不会因为本地测试通过就证明账号权限、索引或云端持久化可用。报告目录 `.local/` 被 Git 忽略。

仓库锁定官方 SDK `@alicloud/log` `1.2.6`，写入方法为 `postLogStoreLogs`，读取方法为 `getLogs`；签名及 protobuf 写入由 SDK 完成。它是仓库示例的开发依赖。发布包仍为 `@zeroclave/langfuse-privacy`，只暴露现有 mask API，无 SLS 运行时依赖。[官方 Node SDK 文档](https://help.aliyun.com/en/sls/developer-reference/get-started-with-log-service-sdk-for-node-js)与 [PutLogs 协议](https://help.aliyun.com/en/sls/developer-reference/api-sls-2020-12-30-putlogs)可用于核对云端要求。

根目录 `package.json` 通过 `overrides` 将该 SDK 的 `protobufjs` 统一为仓库锁定的 `8.6.6`，替代 SDK 原先引入的旧版本，并已验证实际 SDK 编码、签名及读回兼容性。将示例迁移到其他项目时，需同时保留相应依赖覆盖并重新验证；只复制示例文件不会带上仓库的依赖配置。

## 排查失败

| 现象 | 检查项 |
| --- | --- |
| 缺少配置 | 在仓库根目录填写 `.env.sls`，核对示例配置中的必填值。 |
| 写入被拒绝 | Project、LogStore 与 endpoint 是否一致，RAM 权限和 STS 三件套是否有效；确认 HTTPS 与网络可达。 |
| 写入成功但读回失败 | 检索权限、`runId` 字段索引、索引生效时间、本次时间范围、查询状态及可检索延迟。 |
| 检测失败 | 检查 ZeroClave 网络、总检测预算及限流；按固定错误码诊断，不增加原文兜底。 |
| 预期敏感值仍存在 | 核对传入范围、检测完整性、实体召回与偏移，保持验收失败并用合成样例复现。 |

不要将密钥、真实客户日志或未经检查的云端响应上传公开 issue。对外分享报告前检查项目标识和读回内容。

## 周三讨论清单

2026-11-16 本地验收结果：类型检查及全部 95 项自动测试通过，其中 SLS 相关 30 项；真实 ZeroClave 检测经官方 SDK 发往本地接收器并读回核验通过，报告为 `.local/sls-transport-live-report.json`，`cloudPersisted: false`。缺少云配置时，云端入口已确认非零退出并记录 `sls_missing_configuration`。这些结果均不代表真实 SLS 已收集成功。

- 已交付：应用内 JSON 字符串处理、官方 SDK 写入、按唯一 `runId` 读回的可运行入口、本地契约测试，以及配置、失败行为和覆盖边界文档。以实际测试结果为准。
- 待云端验收：准备自己的 Project、普通 LogStore、`runId` 索引和 RAM／STS 凭证，运行 `npm run test:sls:live`，保留本次读回报告。未成功执行前，状态仍是待验证。
- 待效果评估：准备双方认可的合成或已授权样本，定义召回、误报、上下文可用性、延迟、吞吐、失败策略及成本指标；当前样例不支持优越性结论。
- 待需求验证：确认业务买方与日志维护者、接入位置、数据出境／私有部署要求、采购预算和验收标准。现有接入不代表已验证客户需求或销售意向。

本示例由 ZeroClave 维护，是基于阿里云公开 SDK 的社区接入，不代表阿里云官方合作或认证。
