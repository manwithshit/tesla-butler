---
task: m1-maintainer-onboarding
executor: codex
dispatched: 2026-08-25
type: deterministic
scope:
  - tasks-for-codex-night-1/task-2_m1-maintainer-onboarding/**
status: pending
---

> 路径说明：下文 `$PROJECT_ROOT` 指你自己的项目工作目录；先在该目录执行 `export PROJECT_ROOT="$(pwd)"`。

# M1 长期维护接手验收

## 目标

让 M1 上的 Codex 获得项目背景、当前实现、隐私边界、双机状态和固定修 Bug 流程，并确认本机代码与远端一致。

## 完成定义

- M1 仓库已快进到 `origin/main` 最新提交，工作树在写入本任务产出前干净。
- 能说明项目目的：把 TeslaMate 新行程和充电账单翻译为人民币小票、五档油车对比和飞书主动推送，同时保持数据本地化。
- 能说明数据链路：TeslaMate → PostgreSQL/MQTT → 本地 Worker → 飞书；Apple Vision OCR 优先、K3 可选兜底。
- 能说明自动与手动入口、行程防抖、充电幂等、上海时区和隐私边界。
- `npm test`、`npm run test:live`、`npm run test:charging-live`、`npm run test:trip-live` 全部通过。
- M1 TeslaMate 仍停止，`com.tesla-saving-ticket.worker` 仍未加载；不得执行最终切换。
- 在本任务文件夹下创建 `codex-YYYYMMDD-HHMM/DONE.md`，记录理解摘要、验证证据、停止状态和后续修 Bug 的操作规则。

## 范围约束

只允许改动 frontmatter `scope` 列出的路径，禁止修改其它文件或运行配置。允许只读检查仓库、数据库快照和服务状态。

不得启动 M1 TeslaMate，不得加载飞书 Worker，不得发送真实飞书消息，不得执行 `cutover`，不得删除旧迁移包或修改 M5。

## 背景

GitHub 私有仓库：`https://github.com/manwithshit/tesla-player`。

M1 工作目录：`$PROJECT_ROOT`。

项目来自小红书创作方向：Tesla App 虽然提供燃油费节省总数，但用户更容易理解“同样里程换成轩逸、宝马5系、路虎卫士、保时捷911或兰博基尼超跑要花多少钱”。项目把真实 TeslaMate 行程、行程功率积分耗电、用户确认的充电账单和统一油价口径组合成可核验、可分享的飞书卡片。

产品默认本地运行、无公共服务器。车辆数据只来自授权后且 TeslaMate 在线期间的新数据。自研代码只读 TeslaMate PostgreSQL，不调用车辆控制命令。车辆与行程不使用截图；只有充电账单允许在飞书发图，经 Apple Vision 本地 OCR 识别、必要时 K3 兜底，并由用户确认后入账。

当前输出包括：行程小结及真实轨迹能耗着色、车辆概览、自然本周/本月账单、五档油车预计油费、本月主跑路线、开始充电/即将达到设置上限/充电结束提醒。

自动推送包括完整行程、三类充电状态、上周与上月账单；菜单手动入口只有上次行程、车辆概览、本周账单、本月账单。

行程规则：TeslaMate 无时区时间按 UTC 解析，用户界面显示 `Asia/Shanghai`；结束后等待 5 分钟；同车、间隔不足 5 分钟、端点不超过 100 米时合并；中间充电、长停或位置不连续时拆分；首次启动不重放历史；发送失败持久化重试；持久化事件不保存坐标。

充电规则：MQTT 低延迟、PostgreSQL 每 60 秒补偿；开始、即将达到设置上限、结束各一次；即将达到上限只接受当前会话两分钟内的新数据；不能把 80% 上限写成“充满”。

安全规则：Tesla 账号、密码、MFA、Token、VIN、精确住址、原始 GPS、飞书 App Secret 不得进入 Markdown、Git、聊天或日志。`data/raw/`、`data/processed/`、`infra/teslamate/.env` 不得提交。Owner API Token 不得宣称为细粒度只读 Token。

双机状态：M5 目前仍是唯一采集与飞书回复端。M1 已完成 preflight 恢复，只允许运行 PostgreSQL、Mosquitto、Grafana；TeslaMate 和 Worker 必须保持停止，直到用户明确确认最终切换。此前预迁移口令已经废弃，最终切换必须使用新口令和新的 cutover 包。

文档优先级：`AGENTS.md` → `README.md` → `docs/engineering/260825_M1长期维护交接.md` → 最新工程记录。早期产品文档中“默认不逐程推送”等结论已经过时；保留为历史，不作为当前实现。

后续 M1 修 Bug：先确认主机和实时状态，拉取远端，新建 `codex/<bug-slug>`，用失败测试锁定用户行为，最小修复，执行全量与相关 live 验证，检查敏感 diff，提交并推送。M1 未完成 cutover 前不得把本地快照测试冒充实时线上验证，也不得重启 Worker。

## 验证方式

```bash
cd "$PROJECT_ROOT"
git pull --ff-only
git status --short --branch
npm ci
npm test
npm run test:live
npm run test:charging-live
npm run test:trip-live
docker compose -f infra/teslamate/compose.yaml ps
launchctl print "gui/$(id -u)/com.tesla-saving-ticket.worker"
```

预期：测试全部通过；M1 TeslaMate 不在 running 状态；Worker 查询返回未加载；Git 不跟踪敏感目录。

## 产出要求

在本任务文件夹创建 `codex-YYYYMMDD-HHMM/DONE.md`，包含：

- `status: success|partial|failed`
- 当前提交与 Git 状态
- 对产品目的、架构、关键规则和隐私边界的简明复述
- 四组测试结果
- M1 TeslaMate / Worker 停止证据
- 后续 M1 修 Bug 的固定起手式
- 未完成部分与剩余风险

不得写入口令、Token、VIN、地址、经纬度、聊天 ID 或 App Secret。
