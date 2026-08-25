# Project Instructions

- 本项目全部开发、调研、配置和生成产物必须保存在当前项目根目录内。
- 产品默认是本地运行、无公共服务器的自助工具；不得引入用户数据上传、账号体系或共享后端作为 1.0 前置条件。
- Tesla 账号、密码、MFA、Access Token、Refresh Token、VIN、精确住址和原始 GPS 轨迹不得写入 Markdown、Git、聊天记录或日志。
- 车辆与行程数据不接受截图/OCR/手工录入，从本机授权后由 TeslaMate 采集新数据；充电账单允许用户在飞书单聊发送截图，经视觉模型识别并由用户确认后写入本地账本。
- 1.0 采集层优先使用 TeslaMate 官方项目镜像与 PostgreSQL；不修改 TeslaMate 本体，自研部分只读其数据库并生成省钱小票。
- 个人车主原型默认使用 TeslaMate 当前支持的 Owner API Token 路径；必须在文档中明示其为非官方 API，可能因 Tesla 变更而失效。
- Tesla 官方 Fleet API / Fleet Telemetry 作为后续迁移路径，不作为 M5 本地原型的前置条件。
- 用户只在本机 Tesla 官方登录页或本地授权工具中输入凭证。
- 官方 Fleet API 路径默认只请求读取所需的 OAuth scopes，不请求 `vehicle_cmds`。Owner API Token 不能认定为细粒度“只读 Token”；我们的代码不得执行解锁、启动、鸣笛、远程启动等车辆命令。
- 授权不等于数据已经开始累积；只有 TeslaMate、PostgreSQL 和 M5 在车辆行驶时持续运行且联网，新行程才能被记录。
- 原始数据写入 `data/raw/`，脱敏中间数据写入 `data/processed/`，二者默认不提交 Git。
- 分享图片必须模糊家庭、公司和其他敏感地点；对外内容不得显示 VIN、精确经纬度或 Token。
- 所有油耗、油价、电价必须保存来源和生效日期；实际值、估算值和未知值必须明确区分。
- 历史充电与历史行程分开处理：不得把 Tesla App 中可见的充电统计误称为可取得的历史路线。
