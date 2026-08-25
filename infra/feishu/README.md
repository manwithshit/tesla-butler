# 飞书机器人配置

## 已发布状态

- 应用名称：特斯拉小管家
- 应用版本：1.0.1
- `lark-cli` Profile：`tesla-saving-ticket`
- 运行身份：bot-only
- 事件与回调：都使用长连接，不需要公网回调 URL

App Secret 和各类 Token 由本机 `lark-cli` 凭证存储管理，不进入本项目、Git 或日志。

## 最小权限

| Scope | 用途 |
|---|---|
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:message:readonly` | 读取消息资源，下载充电账单截图，获取回调卡片内容 |
| `im:message:send_as_bot` | 发送行程小票、确认卡片和周报/月报 |
| `im:resource` | 上传或发送卡片所需图片/文件资源 |

不使用用户身份、通讯录、文档、日历、群聊全量消息、车辆控制或外部群权限。

## 事件与回调

- 事件：`im.message.receive_v1`
- Card 2.0 回调：`card.action.trigger`
- 旧版回调 `card.action.trigger_v1` 未启用

运行时必须用显式 Profile，避免误用本机的通用飞书应用：

```bash
lark-cli --profile tesla-saving-ticket event consume im.message.receive_v1 --as bot
lark-cli --profile tesla-saving-ticket event consume card.action.trigger --as bot
```

两个 consumer 共用同一个飞书 WebSocket bus。生产运行时不要用 `kill -9`；关闭时向进程发送 `SIGTERM`。

## 本机验证

```bash
lark-cli --profile tesla-saving-ticket whoami

lark-cli --profile tesla-saving-ticket event consume \
  im.message.receive_v1 --as bot --timeout 5s >/dev/null

lark-cli --profile tesla-saving-ticket event consume \
  card.action.trigger --as bot --timeout 5s >/dev/null
```

有效启动证据：

```text
[event] ready event_key=im.message.receive_v1
[source] feishu-websocket: connected
[event] ready event_key=card.action.trigger
```

严格的四项权限不包含飞书开发者后台自检所用的 `application:*` / `admin:*` Scope，因此 `lark-cli` 可能提示 `skipped console precheck`。只要后续出现 `ready` 与 `feishu-websocket: connected`，实际长连接即已建立。

## 下一步端到端验证

1. 在飞书中打开“特斯拉小管家”单聊。
2. 发送一张打码的测试图片。
3. 消费 `im.message.receive_v1`，用 `message_id + image_key` 下载资源。
4. 回复一张带“确认”按钮的 Card 2.0 测试卡。
5. 点击按钮，确认收到 `card.action.trigger`。

这一步会真实接收用户图片并向飞书发送消息，应使用专门的打码测试素材，不要使用 Tesla Token、VIN 或精确位置截图。

## M5 常驻 Worker

- LaunchAgent：`com.tesla-saving-ticket.worker`
- 入口：`src/worker.mjs`
- OCR：Apple Vision 为默认本地识别链路。只有环境中明确配置 `KIMI_BASE_URL` 时，才把对应 K3 服务作为未知版式兜底；项目不保存 API Key。
- 保活：LaunchAgent 用 `caffeinate -ims` 包裹 Worker，避免 M5 因系统睡眠中断采集，同时允许显示器正常熄屏。
- 数据：TeslaMate PostgreSQL 只读；截图保存在 `data/raw/feishu/`，确认后的结构化账单保存在 `data/processed/receipts.json`，均不提交。

文字入口：

- `菜单` / `帮助`：Card 2.0 功能菜单。
- `上次行程` / `最近一程` / `最近`：最近完整行程。
- `本周` / `本周账单`：本周汇总。
- `本月` / `本月账单` / `省了多少`：本月汇总。
- `车辆概览` / `概览`：最新电量、续航、里程、车辆状态，以及本月行程次数/里程/时长。
- 图片或只含图片的 `post` 富文本：无需菜单前置操作，先回复“已收到”；Apple Vision 在本机提取可见费用字段，由代码换算并校验电量。关键字段缺失且已配置 K3 时才进入增强识别，之后返回“确认记账 / 忽略”卡片。最终成功或失败都会明确回复。
- 定时推送：与机器人完成首次单聊后，默认每周一 09:00 推上周账单、每月 1 日 09:10 推上月账单；相同周期只发送一次。

维护命令：

```bash
launchctl print gui/$(id -u)/com.tesla-saving-ticket.worker
launchctl kickstart -k gui/$(id -u)/com.tesla-saving-ticket.worker
tail -f data/processed/logs/worker.log
node src/cli.mjs push-preview
npm test
npm run test:live
npm run migrate:receipts
```

Card 2.0 回调去重必须使用每次点击独立的 `event_id`，不能使用同一张卡的 `message_id`；否则第一个按钮响应后，后续按钮会被错判为重复事件。
