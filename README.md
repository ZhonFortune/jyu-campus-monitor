# JYU - CAMPUS - MONITOR

<center>

嘉应学院宿舍电费余额监控服务。服务按随机 30-60 min 间隔查询电费余额，并在余额低于阈值时通过 Telegram 发送提醒。<strong>你可以点击下方 Deploy 字样按钮使用 Vercel 平台一键部署服务。</strong>
<br>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor.git&project-name=jyu-campus-monitor&repository-name=jyu-campus-monitor&env=ACCESS_TOKEN,CRON_SECRET,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,DORM_BUILDING_NAME,ROOM_NUMBER,POWER_FEE_REMIND_THRESHOLD,POWER_FEE_REPEAT_THRESHOLD,YKT_SESSION_ID&envDescription=%E9%85%8D%E7%BD%AE%E5%AE%BF%E8%88%8D%E7%94%B5%E8%B4%B9%E6%9F%A5%E8%AF%A2%E3%80%81Telegram%20%E6%8E%A8%E9%80%81%E5%92%8C%20Vercel%20Cron%20%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5&envLink=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor%23%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F)

[强密钥生成工具](https://onetools.online/zh/token-generator?length=64&uppercase=true&lowercase=true&numbers=true&symbols=false)

</center>

> 由于 Vercel 部署使用 Serverless API。定时查询由 `vercel.json` 中的 Cron 调用 `GET /power-fee/cron` 完成。因此，部署时需要配置 `CRON_SECRET` 环境变量以验证 Cron 调用。

<br>

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `PORT` | 本地服务端口 | `6888` | 否 |
| `LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` | `INFO` | 否 |
| `CORS_ORIGIN` | 跨域来源 | `*` | 否 |
| `ACCESS_TOKEN` | 手动调试接口访问令牌 | 无 | 否 |
| `CRON_SECRET` | Vercel Cron 调用 `/power-fee/cron` 的鉴权密钥 | 无 | Vercel 必填 |
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人访问密钥 | 无 | 否 |
| `TELEGRAM_CHAT_ID` | Telegram 接收会话 ID，多个 ID 用英文逗号分隔 | 无 | Vercel 推荐 |
| `POWER_FEE_REMIND_THRESHOLD` | 首次提醒阈值，单位：元 | `20` | 否 |
| `POWER_FEE_REPEAT_THRESHOLD` | 二次提醒阈值，单位：元 | `10` | 否 |
| `SCHOOL_AREA_NO` | 校区编号 | `1` | 否 |
| `DORM_BUILDING_NAME` | 宿舍栋名称 | 无 | 是 |
| `ROOM_NUMBER` | 房间号 | 无 | 是 |
| `YKT_SESSION_ID` | 校园卡门户 `JSESSIONID` | 无 | 否 |

<br>

## Telegram 通知

使用已存在的或新创建的 Telegram 机器人，配置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。

> Telegram 机器人创建：[https://core.telegram.org/bots#6-botfather](https://core.telegram.org/bots#6-botfather)
> Telegram 获取 Chat ID：[https://core.telegram.org/bots/api#getupdates](https://core.telegram.org/bots/api#getupdates)


使用自定义菜单添加以下已受支持的命令以完成快速操作

```text
/start  登记接收会话并查看运行状态
/left   查询当前电费余额
```

<br>

## 本地开发

以下用例假设服务已运行在默认地址 `http://localhost:6888`上，并且 `.env` 中已配置有效的 `ACCESS_TOKEN`、宿舍栋名称和房间号。调试推送需要配置 `TELEGRAM_BOT_TOKEN` 并向机器人发送 `/start`。

### 1. 仅抓取一次电费余额

携带 `ACCESS_TOKEN` 直接触发一次查询。该请求会执行正常阈值规则。

```bash
curl -X POST "http://localhost:6888/power-fee/fetch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{}'
```

### 2. 调试推送

`debugPush` 为 `true` 时会忽略阈值，查询成功后立即发送一条 Telegram 测试消息。

```bash
curl -X POST "http://localhost:6888/power-fee/fetch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"debugPush":true}'
```

预期响应中的 `debugPushed` 为 `true`。

### 3. 使用查询参数传递访问令牌

适合临时浏览器或简单脚本调试。

```bash
curl -X POST "http://localhost:6888/power-fee/fetch?accessToken=<ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"debugPush":true}'
```

### 4. 临时覆盖宿舍信息

用于验证新的宿舍栋和房间号。服务会自动查询对应的门户内部编号。

```bash
curl -X POST "http://localhost:6888/power-fee/fetch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{
    "debugPush": true,
    "schoolAreaNo": "1",
    "dormBuildingName": "宿舍栋",
    "roomNumber": "房间号"
  }'
```

<br>

## Vercel Cron 触发

Vercel Cron 会自动请求该接口。手动验证时使用 `CRON_SECRET`：

```bash
curl -X GET "https://<your-vercel-domain>/power-fee/cron" \
  -H "Authorization: Bearer <CRON_SECRET>"
```