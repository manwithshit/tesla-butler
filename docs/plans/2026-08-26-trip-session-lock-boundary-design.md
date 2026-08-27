# 行程会话落锁边界设计

## 目标

把自动行程推送从“数据库行程结束后静默约 5 分钟”升级为由 PostgreSQL 行程事实与 TeslaMate MQTT 低延迟信号共同驱动的持久化状态机。系统不得控制车辆，也不得把 MQTT 当作里程、轨迹或能耗事实来源。

## 设计原则

- PostgreSQL 是行程段、GPS、时间和能耗的唯一事实来源。
- MQTT 只提供 `locked`、`driver_front_door_open` 和既有充电状态变化等边界信号。
- 行驶中的自动落锁不构成行程结束。
- MQTT retained/current 消息只建立 baseline，不制造边沿事件。
- 门或锁消息缺失时宁可延迟合并，也不误拆分；充电开始和一小时无活动负责兜底。
- 所有状态变化、segment ids、pending event、sent key 和最后活动时间均写入现有本地 runtime state。
- 不在日志、文档或持久化新增精确坐标、车辆标识、收件标识或凭证。

## 状态模型

新增纯状态机 `TripSessionTracker`，由现有 `TripTracker` 对外兼容导出。持久化结构版本为 3：

```js
{
  version: 3,
  initialized: true,
  last_processed_drive_id: 0,
  session: null,
  signals: {
    locked: { initialized: false, value: null },
    driver_front_door_open: { initialized: false, value: null }
  },
  pending_events: {},
  sent_keys: {}
}
```

活动 session 只保存状态机所需数据：

```js
{
  phase: "driving" | "parked" | "door_open" | "door_closed" | "finalizing",
  segment_ids: [],
  started_at: "ISO timestamp",
  active_started_at: null,
  last_event_at: "ISO timestamp",
  parked_at: null,
  finalize_at: null,
  finalization_reason: null,
  boundary_candidate: null
}
```

pending event 只保存 `segment_ids` 和幂等 key。发送时再从 PostgreSQL 重建聚合行程，避免把位置数据复制到 runtime state。

## 状态转换

### 启动与驾驶

1. 新安装首次数据库检查只建立 `last_processed_drive_id` baseline，不回放历史行程。
2. 已初始化 Worker 发现 active drive 时创建或恢复 `driving` session。
3. 行驶中收到任何 `locked=true` 只更新 baseline，不进入 finalizing。

### 停车、开门、关门和落锁

1. 每轮先吸收所有新 completed drive，再判断 active drive、落锁候选和超时；不得在数据库新段尚未吸收前发送旧 session。
2. 新 completed drive 写入当前 session 的 `segment_ids`，状态进入 `parked`。
3. `driver_front_door_open` 的 `false → true` 记录持久化候选并把已停车状态推进到 `door_open`。
4. 随后的 `true → false` 记录候选关门时间并把已停车状态推进到 `door_closed`。
5. 只有门序列完成后出现新的 `locked false → true`，才补齐候选落锁时间。
6. 若 MQTT 边沿早于 PostgreSQL 的 completed 可见性，候选在 `driving` 中只缓存、不结束；即使 active 暂时消失，只要对应 completed 尚未吸收，也不得排队。数据库段落盘后，候选开门时间必须位于最后段结束后，允许最多 10 秒的提交时钟容差，才进入 `finalizing`。更早的候选会被清除。
7. `finalize_at` 固定为落锁时间加 45 秒。
8. trip DB 每 15 秒检查一次；达到 `finalize_at`、数据库已经没有 active drive 且所有 completed 段已吸收后，创建一个 pending event 并尝试发送，因此正常推送窗口为确认离车后约 45–60 秒。

单独落锁、单独开关门、重复相同值以及行驶中的落锁均不会结束行程。

### 未落锁续驾与超时

- `parked` 后再次出现 active drive，且尚未确认真实边界，则恢复 `driving` 并继续累计同一 session；active drive 无条件压制 parked 超时，避免长行程被上一段停车时间截断。
- 恢复驾驶时清除未完成的旧门锁候选，避免后续缺失门事件时误用上一次停车信号。
- 真实字段变化、驾驶变化或充电变化会更新 `last_event_at`；重复相同 MQTT 值不会延长超时。
- `parked` 后连续一小时没有驾驶、充电或相关字段变化，直接把已有 segments 排入 pending 并结束 session。此时数据库已稳定，无需再增加 45 秒。

### 充电边界

- MQTT 或数据库补偿链路首次观察到新的 charging `started` 事件时，当前 trip session 立即进入 `finalizing`。
- 充电边界同样使用 45 秒稳定窗口；已有充电提醒的 started、near-limit、completed 行为保持不变。

## retained 与重启语义

- 每个 trip signal 的第一条消息只初始化 baseline；`packet.retain=true` 时无条件禁止生成边沿。
- Worker 重启后从 runtime state 恢复 session、signal baseline、pending events 和 sent keys。
- 旧版 `pending_events[*].trip.segment_ids` 在构造器中迁移为新版最小 pending 格式。
- 发送失败时 pending 不 ack；下次 DB 检查重试。
- 发送成功后才删除 pending 并写入 `sent_keys[eventKey]=true`；同一 key 永不重复排队。
- 旧版已发送行程仍由 `last_processed_drive_id` 防止回放。

## Worker 集成

- 新增 `vehicle-signals.mjs`，只解析 `locked` 与 `driver_front_door_open` 的布尔载荷。
- Worker 在既有 charging topics 基础上订阅这两个 topics；不依赖 `shift_state`。
- trip tracker 在 MQTT 订阅开始前完成恢复和首次数据库检查，保证 retained baseline 不早于状态机初始化；每个门锁信号入队后也先做一次数据库核对，尽量先确认停车事实再应用门锁边沿。
- MQTT trip signal 与 trip DB 检查共用 `tripQueue` 串行化，避免状态写入竞争。
- Worker 只记录 phase、segment 数、pending 数、active 布尔、候选阶段和原因的聚合状态变化，便于线上定位且不暴露行程内容。
- charging MQTT 和 charging DB 补偿链路均把新的 started 事件通知 trip tracker。
- 保留既有 Feishu consumer、充电队列、scheduler 和地图处理架构。

## 行程卡与失败反馈

- pending 发送时按 `segment_ids` 从 PostgreSQL 读取聚合行程，再调用既有 `sendCompletedTrip`。
- 地图继续使用现有 `resolveRouteImage`：缓存命中、渲染重试两次、上传重试两次、缓存写入容错。
- 地图最终失败仍发送明确的“地图生成失败，可重新点击”卡片，不静默降级成“没有行程”。
- Feishu 整卡发送失败时 pending 保留并重试；日志只记录阶段和安全错误类别。
- 卡片时间继续使用现有 Asia/Shanghai 转换，不修改格式化实现。

## 数据库聚合

- 手动“上次行程”和周期报表继续使用现有 5 分钟、100 米分组默认值，避免行为回归。
- 自动 session 的 segments 来自状态机；发送时允许一小时内的 session 聚合，但仍要求相邻端点在 100 米内且期间无充电。
- 若聚合暂不可用，pending 保留并在下一轮重试，不丢弃行程。

## 验证边界

自动化测试和 live-safe dry-run 可以证明状态转换、持久化、幂等、数据库读取、服务接线和旧事件不回放。没有真实车辆事件时，不能声称已经验证实际 `停车 → 驾驶门开 → 关 → 新落锁` 的 TeslaMate MQTT 顺序；该项留待下一次真实车辆行为验收。
