---
task: 在 M1 上完成特斯拉小玩家的预迁移与验收
executor: codex
status: pending
scope:
  - scripts/migration/**
  - infra/teslamate/**
  - infra/launchd/**
  - data/raw/**
  - data/processed/**
  - tasks-for-codex-night-1/task-1_m1-migration-verify/**
---

## Context

你当前位于 M1。目标是验证 M5 的代码和历史数据能在 M1 恢复，但本任务只做预迁移，不做最终切换。

- M5 此时仍在运行 TeslaMate 和飞书 Worker，继续采集真实数据。
- 代码来自私有 GitHub 仓库。
- 历史数据通过 iCloud Desktop 上的 `tesla-saving-ticket-m5-preflight-*.tar.enc` 加密包传输。
- 加密包包含 PostgreSQL 逻辑备份、TeslaMate `.env`、本地充电账本、飞书账单图片和运行状态。
- 飞书 App Secret 在 macOS Keychain，不在 GitHub 和迁移包中；预迁移阶段无需配置。
- Tesla 账号、Token、VIN、精确地址、GPS 轨迹、飞书 App Secret 不得写入对话、日志、Markdown 或 Git。

关键脚本：

- `scripts/migration/import-m1.sh`
- `scripts/migration/verify-m1.sh`
- `scripts/migration/install-launch-agent.sh`（本任务禁止执行）
- `docs/engineering/260825_M5迁移M1_方案与操作.md`

## Deliverables

1. 在 M1 安装并验证最低依赖：Docker Desktop、Node.js 22+、`npm`、`xcrun`。`lark-cli` 可检查但无需在本任务绑定凭证。
2. 在项目根目录执行 `npm ci` 和 `npm test`。
3. 找到 iCloud Desktop 上最新的 `preflight` 加密包及同名 `.sha256`。
4. 在用户本人面对终端时执行：

   ```bash
   ./scripts/migration/import-m1.sh \
     --bundle "$HOME/Desktop/tesla-saving-ticket-m5-preflight-时间.tar.enc" \
     --replace-target-db \
     --mode preflight
   ```

   迁移口令只能由用户在隐藏输入提示中输入，不得要求用户发到聊天中。
5. 执行 `./scripts/migration/verify-m1.sh preflight`，核对数据库计数与迁移包 manifest 一致。
6. 验证预迁移状态：M1 的 PostgreSQL 与 Grafana 可运行；M1 的 TeslaMate 与 `com.tesla-saving-ticket.worker` 必须保持停止。
7. 记录 M1 的项目绝对路径、Node/Docker/lark-cli 实际路径和数据库计数，但不得记录任何密钥或原始位置数据。

## Completion Criteria

- `npm test` 全部通过。
- 加密包 SHA-256 校验通过，包内文件校验通过。
- PostgreSQL 恢复成功，`drives|positions|charging_processes` 与 manifest 完全一致。
- `npm run test:live` 通过。
- `npm run test:charging-live` 通过，确认最新充电会话只读查询、结束卡片和旧事件不重放。
- `npm run test:trip-live` 通过，确认短停合并后的最新行程、路线卡片和启动不重放历史。
- M1 TeslaMate 未启动，M1 飞书 Worker 未加载；M5 仍是唯一采集和回复端。
- 未把 `.env`、`data/raw/`、`data/processed/` 或任何凭证加入 Git。
- 未执行最终切换。最终切换必须等待用户明确确认，并使用新的 `cutover` 包。

## Final Output

完成后新建 `codex-YYYYMMDD-HHMM/DONE.md`，只写：

- 完成结果
- 验证命令与通过证据
- 数据库三项计数
- M1 TeslaMate / Worker 停止状态
- 未完成部分与剩余风险
- 最终切换前需要用户确认的唯一下一步

不要在 `DONE.md` 中写入迁移口令、`.env` 内容、Token、VIN、地址、经纬度、聊天 ID 或 App Secret。
