# 连接你自己的飞书机器人

**Docker 负责采集，Mac Worker 负责计算，飞书机器人负责收发。三部分连接好，才能收到行程卡和周报。**

这里配置的是支持单聊和交互卡片的自建应用机器人，不是群聊 Webhook。每位部署者创建自己的应用，不使用作者的 App ID、Secret 或会话。

## 1. 安装 CLI，创建应用

按 [飞书官方 CLI 安装说明](https://github.com/larksuite/cli/blob/main/README.zh.md) 安装：

```bash
npx @larksuite/cli@latest install
```

进入 [飞书开发者后台](https://open.feishu.cn/app)，创建自建应用，名称可填 **特斯拉小玩家**，启用机器人能力。应用可用范围仅选择你自己；企业租户可能需要管理员审核。

当前代码面向单车主：未设置固定车主的会话白名单，新的单聊可能更新主动推送的接收会话。请勿把同一套车辆数据的机器人开放给其他人。

## 2. 在本机绑定应用

```bash
lark-cli config init --name tesla-saving-ticket
```

按交互提示选择上一步的应用，将凭证保存在本机 CLI 凭证存储。不要将 App Secret 放进命令参数、项目文件、截图或 Git。

`tesla-saving-ticket` 是保留的内部 Profile 名，与 Worker 默认配置一致。项目名称为“特斯拉小玩家”，两者不影响使用。若使用其他 Profile，启动 Worker 时须同步设置 `LARK_PROFILE`。

本项目用应用身份（`--as bot`）工作，不需要为了机器人收发而申请个人文档、日历或通讯录授权。

## 3. 开通权限和长连接

在应用后台为机器人配置以下权限：

| Scope | 用途 |
| :--- | :--- |
| `im:message.p2p_msg:readonly` | 接收发给机器人的单聊消息 |
| `im:message:readonly` | 读取消息与账单图片资源 |
| `im:message:send_as_bot` | 发送行程、账单和交互卡片 |
| `im:resource` | 上传卡片图片及文件 |

在“事件与回调”中选择 **长连接**，添加：

| 类型 | 订阅项 |
| :--- | :--- |
| 接收消息事件 | `im.message.receive_v1` |
| 卡片回传交互回调 | `card.action.trigger` |

无需公网 IP、域名或内网穿透。配置过程中若后台提示尚未检测到连接，在项目目录执行 `npm run worker`，等待两个订阅就绪，再回后台保存。不要为测试再启动第二套 Worker。

## 4. 发布并确认生效

在版本管理中创建版本并发布，让机器人能力、权限、订阅和可用范围生效；如租户要求审核，等待管理员批准。个人应用若显示免审或已生效，以后台实际状态为准。只保存配置，不代表已生效。

官方说明：[启用机器人能力](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-enable-bot-ability)。

## 5. 启动并验证收发

若 Worker 尚未运行，在项目目录启动：

```bash
npm run worker
```

Worker 管理消息与卡片回调两类 consumer，共用飞书 WebSocket bus。就绪时可看到：

```text
[event] ready event_key=im.message.receive_v1
[source] feishu-websocket: connected
[event] ready event_key=card.action.trigger
```

然后在飞书打开自己的机器人单聊：

1. 发送 **菜单**，确认收到功能卡片。
2. 点击 **车辆概览**，确认按钮有回复；新部署没有数据不等于连接失败。
3. 设置 **默认电价**。有充电账单时，可发脱敏截图并确认识别结果。
4. 之后保持采集与 Worker 在线，用一次新行程验证主动推送。首次单聊后，周报和月报才有接收会话。

> CLI 的 `skipped console precheck` 不一定是连接失败：本项目的最小权限不包含后台自检所用的应用管理权限。以实际长连接就绪和飞书收发结果为准。

## 排查常见问题

| 现象 | 优先核对 |
| :--- | :--- |
| Docker 正常，飞书没消息 | Worker 是否启动；Profile 是否绑定到自己的应用 |
| 找不到机器人或不能发消息 | 机器人能力、可用范围及版本是否生效 |
| 消息有回复，按钮没反应 | `card.action.trigger` 是否配置；是否有另一套同应用连接 |
| 有菜单，但行程为空 | TeslaMate 授权后是否实际采集过新行程 |
| 账单识别不完整 | Mac 本地 OCR 和图片清晰度；按提示补充后确认，草稿不会入账 |

## 本地运行与数据

- 入口：`src/worker.mjs`；默认 OCR：macOS Apple Vision。当前机器人允许不完整识别形成草稿，由用户补充确认。
- 原始账单图片：`data/raw/feishu/`；本地账本：`data/processed/receipts.json`，均不提交 Git。图片通过飞书收发，“本地 OCR”不等于图片没有经过飞书平台。
- PostgreSQL 是行程与充电的事实来源；MQTT 提供状态变化信号。行程结束规则见[主 README](../../README.md#行程何时算结束)。
- 默认每周一 09:00 推送上周账单、每月 1 日 09:10 推送上月账单（Asia/Shanghai）；同一周期只发送一次。
- 已有常驻服务的 LaunchAgent 标签仍为 `com.tesla-saving-ticket.worker`。使用 `SIGTERM` 正常停止进程，勿同时运行手动 Worker 和常驻 Worker。

返回 [部署总览](../../README.md#本地安装与首次运行)。
