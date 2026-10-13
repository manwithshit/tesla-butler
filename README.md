<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="./assets/readme/hero-driving-records.svg" width="100%" alt="特斯拉小管家：把本机 TeslaMate 数据变成飞书里的行程小结、充电提醒和用车记录">
</p>

<p align="center">
  面向个人 Tesla 车主的本地自托管工具。原始车辆数据留在自己的电脑上，结果通过飞书主动到达。
</p>

<p align="center">
  <a href="#本地安装与首次运行">开始部署</a> · <a href="infra/feishu/README.md">连接飞书</a> · <a href="#它怎么工作">工作原理</a>
</p>

## 真实手机截图

下面五张均为手机里的真实飞书截图，不是概念图。前四张直接使用用户提供的原始 PNG；充电截图仅对 VIN 行做必要遮挡。所有图片均未裁剪或缩放，产品结果没有改写。

<table>
  <tr>
    <th align="center" width="50%">🧾 行程结束推送<br><sub>每段完整行程的费用、能耗、里程与驾驶建议</sub></th>
    <th align="center" width="50%">📊 本周小结推送<br><sub>周期里程、电费与油车费用对比</sub></th>
  </tr>
  <tr>
    <td align="center" valign="top" width="50%">
      <img src="./assets/readme/trip-summary.png" alt="手机原始截图中的真实行程小结：展示行程电费、耗电、里程、时长、路线地图和驾驶建议">
    </td>
    <td align="center" valign="top" width="50%">
      <img src="./assets/readme/weekly-report.png" alt="手机原始截图中的真实本周小结：展示累计里程、耗电、行程电费和多档油车费用对比">
    </td>
  </tr>
  <tr>
    <th align="center" width="50%">🧭 功能菜单<br><sub>快速查询行程、车辆、周/月账单与默认电价</sub></th>
    <th align="center" width="50%">🚗 车辆概览<br><sub>当前电量、预计续航与本月行驶统计</sub></th>
  </tr>
  <tr>
    <td align="center" valign="top" width="50%">
      <img src="./assets/readme/bot-menu.png" alt="手机原始截图中的真实飞书机器人菜单：提供行程、车辆、周账单、月账单和充电账单入口">
    </td>
    <td align="center" valign="top" width="50%">
      <img src="./assets/readme/vehicle-overview.png" alt="手机原始截图中的真实车辆概览：展示电量、预计续航、总里程和本月行驶汇总">
    </td>
  </tr>
  <tr>
    <th align="center" colspan="2">⚡ 充电账单识别<br><sub>识别费用与电量，并尝试关联 TeslaMate 充电会话</sub></th>
  </tr>
  <tr>
    <td align="center" valign="top" colspan="2">
      <img src="./assets/readme/charging-status.jpg" width="48%" alt="真实充电账单识别截图：收到充电账单后识别费用与电量，VIN 已遮挡">
    </td>
  </tr>
</table>

> 截图记录于持续迭代阶段。当前菜单已新增等宽的“设置默认电价”入口；月报也会显示统计周期、TeslaMate 驾驶记录数、真实计价依据，并按累计里程选择主跑路线。截图中的旧名称和主机标签来自早期版本；当前项目统一名为“特斯拉小管家”。

## 它能做什么

- **行程小结**：把 TeslaMate 记录的完整行程换算成里程、估算耗电、行程电费和同里程油车费用对比。
- **充电提醒**：开始充电、即将达到设置上限、充电结束时主动提醒；预计时间来自 TeslaMate 当前会话，慢充会直接显示为小时和分钟，不使用写死的“15 分钟”。
- **充电账单与个人电价**：菜单可查看或修改默认电价；账单图片经识别和用户确认后进入本地账本，可靠关联充电会话后会按当次真实综合单价逐步分摊。
- **车辆概览**：集中显示最近采集的电量、续航、车辆状态，以及本月里程与时长。
- **周结与月结**：按自然周期汇总累计里程、耗电和行程电费；月报明确统计区间、原始驾驶记录数和计价口径，并展示累计贡献里程最高的重复路线。
- **事实型驾驶提示**：只使用本次真实行程和同路线历史。样本不足、采样不可靠或近期模板重复时直接隐藏，不展示固定的泛化建议。

### 电费如何计算


系统把“日常默认电价”和“已可靠关联的充电账单”分开保存，不用账单平均价粗暴改写所有历史：

1. **默认电价**：首次设置会补算此前尚未定价的行程；以后修改只对修改后开始的新行程生效。
2. **账单实际价**：每张已确认且可靠关联 TeslaMate 充电会话的账单，都会形成一批带真实综合单价的电量。
3. **逐步消耗**：这批电量从对应充电结束后开始，按行程顺序逐步消耗；用完后再回到当时生效的默认电价。
4. **无法可靠关联**：账单仍保存在本地账本，但不会进入行程电费分摊，避免把价格套到错误的充电会话。

完整图片账单默认在收到前 7 天的已完成充电中寻找候选，并同时参考时间与电量。只有一个候选足够可靠时才自动关联；出现多个相近候选时由用户在卡片中选择。同一充电会话不能被两张已确认账单重复占用。

### 账单识别不完整，也能继续补充

- 图片识别后返回草稿，缺失或不可靠的字段明确提示；OCR 不可用时仍可用文字新建草稿。草稿不计入费用统计。
- 直接回复“充了30度”“金额应该是24元”，或一次说明“昨天充了30度，花了24元”。支持数字金额、电量、`YYYY-MM-DD HH:mm` 日期时间以及今天／昨天／前天（UTC+8）；裸数字、提问、默认电价命令不会作为账单补充。
- 每次只补充当前会话中唯一一张待确认草稿；多张待确认时先确认或忽略其他草稿，不自动猜选。修改后需在最新版卡片确认；重复消息不重复新增记录，已确认账单不能被文字覆盖。
- 文字补充会清除旧的费用拆分、推算单价与车辆充电关联，保留未改动的直接识别电量。文字草稿当前不自动重匹配车辆充电，未关联记录不会用于行程电费分摊。
- 无法可靠区分的多订单／待支付图片不拼凑字段，提示用户提供单笔已支付账单。仍须补齐实付金额和电量、通过校验并点击确认后才入账。

> 兼容说明：自动关联能力上线前已经确认的旧账单不会静默回填。它们仍保留在账本中，但只有完成可靠关联的新账单才会成为实际电价批次。

### 月报主跑路线如何选择

月报不会再简单选择“出现次数最多”的路线。当前规则是：

1. 按起终点聚合同向和反向路线；
2. 只保留周期内至少出现 3 次的路线；
3. 在这些候选中，选择累计行驶距离最高的一条；
4. 累计距离相同时，才使用出现次数作为次级排序。

这样可以避免高频但极短的地库挪车压过真正贡献大部分月度里程的路线。月报油车对比图也会为最高金额预留固定空间，避免手机端把最右侧数字自动隐藏。

### 行程何时算结束

正常边界不是“停车后固定静默 5 分钟”，而是以下事件序列：

```text
PostgreSQL 记录行程结束
        ↓
驾驶门打开 → 关闭（优先路径）
        ↓
出现新的落锁
        ↓
等待约 45–60 秒聚合并推送
```

- 行驶中的自动落锁不会结束行程。
- 如果驾驶门消息漏失，停车后 10 分钟内的新落锁可作为并行边界；确认窗口内重新驾驶会撤销该边界。
- 没有正在等待结束的停车行程时，单独落锁不会创建或推送行程。
- 停车后未落锁且 30 分钟内继续驾驶，会继续合并到同一用户行程。
- 从数据库停车时间起满 30 分钟仍未继续驾驶，由超时边界兜底结束；其他 MQTT 变化不会延长计时。
- 充电开始是强行程边界。
- 行程发送失败会保留待发送状态；成功后才确认，避免重启造成丢失或重复。

## 它怎么工作

```text
Tesla 本机授权
      ↓
TeslaMate
      ├── PostgreSQL：行程、GPS、时间、能耗与充电事实
      └── MQTT：门锁与充电状态的低延迟边界信号
                         ↓
                本地 Worker
                ├── 行程会话与幂等
                ├── 能耗积分与人民币换算
                ├── Apple Vision 本地账单 OCR
                └── 飞书 Card 2.0 与主动推送
```

PostgreSQL 是行程、GPS 和能耗的事实来源。MQTT 只帮助更快识别边界，不能替代数据库事实，也不用于推断路线或费用。

## 隐私与安全边界

- 项目默认本地运行，不运营公共服务器，也不要求账号体系或共享后端。
- Tesla 账号、密码和 MFA 只输入 Tesla 官方登录页或本机授权工具；Token 只交给本机 TeslaMate。
- 个人车主当前使用 TeslaMate 支持的 Owner API Token 路径。它是非官方 API，可能因 Tesla 变更而失效，也不是细粒度“只读 Token”。
- 本项目自研代码只读 TeslaMate PostgreSQL，不发送解锁、启动、鸣笛、远程启动等车辆命令。
- VIN、精确地址、原始 GPS、Token、Secret、飞书消息标识和原始账单图片不得进入 Git、Markdown 或日志。
- 充电账单默认由 macOS Apple Vision 在本机识别；只有用户主动配置外部视觉模型时才启用可选兜底。
- 授权不等于已经有历史数据。TeslaMate 只能持续记录授权后、设备在线运行期间的新行程，不能补录安装前或离线期间的历史轨迹。

## 本地安装与首次运行

代码已公开，当前支持在 Mac 上自行部署。没有 `npx` 一键安装器；可让 AI Agent 按下列步骤协助，账号授权由你本人完成。

**完整部署包含三部分。仅启动 Docker，不会收到飞书报告。**

| Docker：采集 | Mac：整理 | 飞书：收发 |
| :--- | :--- | :--- |
| TeslaMate、PostgreSQL、MQTT、Grafana | Node.js Worker、地图、Apple Vision OCR | 你自己的自建应用机器人 |
| 记录车辆与行程 | 计算电费、生成卡片和报告 | 接收截图、响应菜单、主动推送 |

### 1. 准备环境

- macOS 13+、Node.js 22+、Git、Docker Desktop 或兼容容器运行时。
- Google Chrome（生成地图图片）、Xcode Command Line Tools（编译本地 OCR；未安装时执行 `xcode-select --install`）。
- 飞书账号及创建自建应用的权限；安装 [飞书官方 CLI](https://github.com/larksuite/cli/blob/main/README.zh.md)：

```bash
npx @larksuite/cli@latest install
```

### 2. 获取代码

```bash
git clone https://github.com/manwithshit/tesla-butler.git
cd tesla-butler
npm ci
```

### 3. 启动 Docker 采集服务并授权车辆

```bash
./scripts/init-teslamate-env.sh
docker compose --env-file infra/teslamate/.env \
  -f infra/teslamate/compose.yaml up -d
```

按 [TeslaMate 本地运行栈](infra/teslamate/README.md) 完成车辆授权。账号、MFA 和 Token 仅在 Tesla 官方页面或本机授权工具中处理，不粘贴到聊天、Issue 或日志。

### 4. 连接你自己的飞书机器人

按 [飞书连接教程](infra/feishu/README.md) 完成这条流程：

**创建自建应用并启用机器人 → 可用范围仅限自己 → 本机绑定应用 → 开通权限与长连接 → 发布生效 → 验证收发。**

这不是群聊 Webhook 机器人；每位部署者使用自己的应用凭证。凭证由本机 `lark-cli` 管理，不写进项目。后台如要求先建立长连接，再保存订阅，按教程先启动 Worker 后完成配置。

### 5. 启动本地助手，验证首次收发

```bash
npm run worker
```

在飞书打开自己的“特斯拉小管家”机器人，发送 **菜单**，确认有卡片回复，再点击“车辆概览”。Worker 会维护消息和按钮两类长连接，无需公网服务器或回调域名。同一机器人只运行一套 Worker。

首次没有行程属正常情况：TeslaMate 不会补录安装前的历史轨迹。先设置默认电价，保持采集服务与 Worker 在线，再用之后的新行程验证自动推送。

<details>
<summary>已有部署升级与自定义 CLI 路径</summary>

项目展示名称统一为“特斯拉小管家”，仓库名为 `tesla-butler`。为兼容已有数据，Docker Compose 项目名、LaunchAgent 标签、默认飞书 Profile 仍沿用 `tesla-saving-ticket`；不要为了改名新建数据卷或搬动正在运行的工作目录。`package.json` 的 `private: true` 用于避免误发 npm 包，不表示 GitHub 仓库私有。

程序优先使用显式的 `LARK_CLI` / `DOCKER_CLI` / `NODE_CLI`，其次查找 PATH；lark-cli 和 Docker 还会探测用户安装目录、Apple Silicon 与 Intel 的常见路径。Node 默认复用启动 Worker 的 Node 可执行文件。定制安装可通过上述环境变量覆盖。

维护记录：[可靠性试运行](docs/engineering/260906_M1可靠性试运行.md) · [地图恢复](docs/plans/2026-09-07-map-card-recovery.md) · [停车边界恢复](docs/plans/2026-09-16-trip-boundary-recovery.md)。这些是既有部署记录，不代替你自己的安装验收。

</details>

## 常用命令和验证

```bash
npm run status              # 查看本地连接与数据状态
npm test                    # 不接触真实服务的自动化测试
npm run test:live           # 只读检查本机 TeslaMate 数据
npm run test:charging-live  # 只读检查最新充电会话
npm run test:trip-live      # 只读检查行程聚合
npm run test:trip-session-live
npm run test:trip-insights-live
npm run test:pricing-live   # 只读检查默认价与账单价分摊
```

`*:live` 会读取当前主机上的真实本地数据，不能把通过结果等同于真实车辆、飞书到达或移动端渲染已经验收。不要在错误主机、未确认双机边界或服务状态不明时运行。

停止 TeslaMate 时不要删除数据卷：

```bash
docker compose --env-file infra/teslamate/.env \
  -f infra/teslamate/compose.yaml stop
```

除非明确要删除全部车辆数据，否则不要使用 `down -v`。

## 已知限制

- 代码已公开，当前为 Mac 自托管工具；尚无一键安装器，Apple Vision 识别不能直接在普通 Linux Docker 容器中运行。
- 行程电费来自功率采样积分与用户电价换算，是估算值；采样缺口会降低可靠性。
- 油车费用只比较能源费，不包含购车、折旧、保险、停车和时间成本，并必须保留油耗、油价来源及口径日期。
- Apple Vision 已验证的账单版式仍有限；未知版式可能需要可选兜底或明确失败反馈。
- 账单只有在确认且可靠关联 TeslaMate 充电会话后才会影响行程电费；旧版已确认但未关联的账单不会自动改写历史费用。
- 门锁边界已有自动化和 live-safe 验证；真实车辆的完整 `停车 → 开门 → 关门 → 新落锁` 顺序仍应与下一次实际行程分别验收。
- 历史充电统计与历史路线是两类数据。能看到充电统计，不代表能取得或补回历史行程轨迹。

## 维护文档

- [行程会话落锁边界设计](docs/plans/2026-08-26-trip-session-lock-boundary-design.md)
- [充电账单与 TeslaMate 会话关联方案](docs/plans/2026-08-30-receipt-charging-match.md)
- [默认电价与实际账单分摊设计](docs/plans/2026-08-31-electricity-pricing-ledger-design.md)
- [默认电价与实际账单分摊实施计划](docs/plans/2026-08-31-electricity-pricing-ledger-implementation.md)
- [M1 长期维护交接](docs/engineering/260825_M1长期维护交接.md)
- [M1 最终切换验收](docs/engineering/260825_M1最终切换验收.md)
- [安装授权与本地 OCR 决策](docs/engineering/260825_安装授权与本地OCR_决策交接.md)
- [Tesla 数据获取与开源采集方案](docs/research/260823_开源采集方案选型.md)
- [TeslaMate 本地运行栈](infra/teslamate/README.md)
- [飞书机器人配置](infra/feishu/README.md)
