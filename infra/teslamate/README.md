# TeslaMate 本地运行栈

- TeslaMate：http://127.0.0.1:4000
- Grafana：http://127.0.0.1:3001
- 数据库和 MQTT 不对宿主机或局域网暴露端口。

## 启动

```bash
./scripts/init-teslamate-env.sh
docker compose --env-file infra/teslamate/.env -f infra/teslamate/compose.yaml up -d
```

## 检查

```bash
docker compose --env-file infra/teslamate/.env -f infra/teslamate/compose.yaml ps
docker compose --env-file infra/teslamate/.env -f infra/teslamate/compose.yaml logs --tail=100 teslamate
```

## 停止

```bash
docker compose --env-file infra/teslamate/.env -f infra/teslamate/compose.yaml stop
```

`down` 不会删除命名 volume；不得使用 `down -v`，除非用户明确要求删除全部车辆数据。
