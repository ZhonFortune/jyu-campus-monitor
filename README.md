# JYU - CAMPUS - MONITOR

<center>

嘉应学院宿舍电费余额监控服务。每 1 h 触发一次余额查询，并在余额低于阈值时通过 Telegram 发送提醒。<strong>你可以点击下方 Deploy 字样按钮使用 Vercel 平台一键部署服务并使用 [Github Action 自动部署](#github-actions-自动部署) 完成 CloudBase 函数部署</strong>
<br>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor.git&project-name=jyu-campus-monitor&repository-name=jyu-campus-monitor&env=ACCESS_TOKEN,CRON_SECRET,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,TELEGRAM_PROXY_SECRET,DORM_BUILDING_NAME,ROOM_NUMBER,POWER_FEE_REMIND_THRESHOLD,POWER_FEE_REPEAT_THRESHOLD,YKT_SESSION_ID&envDescription=%E9%85%8D%E7%BD%AE%E5%AE%BF%E8%88%8D%E7%94%B5%E8%B4%B9%E6%9F%A5%E8%AF%A2%E3%80%81Telegram%20%E6%8E%A8%E9%80%81%E5%92%8C%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5&envLink=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor%23%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F)

[强密钥生成工具：用于填充ACCESS_TOKEN、CRON_SECRET或TELEGRAM_PROXY_SECRET](https://onetools.online/zh/token-generator?length=64&uppercase=true&lowercase=true&numbers=true&symbols=true)

</center>

> 由于网络环境问题，建议使用 Vercel 部署服务以正常使用 Telegram 推送功能；使用 Github Action 自动部署 CloudBase 函数以正常获取宿舍电费信息。

<br>

## 使用方法

1. 创建 Telegram Bot，获取 `TELEGRAM_BOT_TOKEN`<br>
2. Fork 本仓库<br>
3. 使用 [强密钥生成工具：用于填充ACCESS_TOKEN、CRON_SECRET或TELEGRAM_PROXY_SECRET](https://onetools.online/zh/token-generator?length=64&uppercase=true&lowercase=true&numbers=true&symbols=true) 生成 `ACCESS_TOKEN`、`CRON_SECRET` 和 `TELEGRAM_PROXY_SECRET`<br>
4. 在 Vercel 中创建项目，并设置[环境变量](#环境变量)<br>
5. 在 CloudBase 中创建环境，并设置[环境变量](#环境变量)<br>
6. 在自己仓库的 Settings -> Secrets and variables > Actions > Repository secrets 中设置 [GitHub Actions 自动部署](#github-actions-自动部署)所需变量<br>

<br>

随后 Deploy 项目即可

<br>

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `PORT` | 本地服务端口 | `6888` | 否 |
| `LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` | `INFO` | 否 |
| `CORS_ORIGIN` | 跨域来源 | `*` | 否 |
| `ACCESS_TOKEN` | 手动调试接口访问令牌 | 无 | 否 |
| `CRON_SECRET` | 定时调用 `/powerfee/cron` 的鉴权密钥 | 无 | Vercel 手动触发必填 |
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人访问密钥 | 无 | Vercel 必填 |
| `TELEGRAM_CHAT_ID` | Telegram 接收会话 ID，多个 ID 用英文逗号分隔 | 无 | 是 |
| `TELEGRAM_PROXY_URL` | Telegram 推送代理地址，例如 `https://<your-vercel-domain>/telegram/push` | 无 | CloudBase 必填 |
| `TELEGRAM_PROXY_SECRET` | Telegram 推送代理鉴权密钥 | 无 | Vercel 与 CloudBase 必填 |
| `POWER_FEE_REMIND_THRESHOLD` | 首次提醒阈值，单位：元 | `20` | 否 |
| `POWER_FEE_REPEAT_THRESHOLD` | 二次提醒阈值，单位：元 | `10` | 否 |
| `SCHOOL_AREA_NO` | 校区编号 | `1` | 否 |
| `DORM_BUILDING_NAME` | 宿舍栋名称 | 无 | 是 |
| `ROOM_NUMBER` | 房间号 | 无 | 是 |
| `YKT_SESSION_ID` | 校园卡门户 `JSESSIONID` | 无 | 否 |

<br>

## Telegram 通知

使用已存在的或新创建的 Telegram 机器人，配置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。

> Telegram 机器人创建：[https://core.telegram.org/bots#6-botfather](https://core.telegram.org/bots#6-botfather) <br> Telegram 获取 Chat ID：[https://core.telegram.org/bots/api#getupdates](https://core.telegram.org/bots/api#getupdates)


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
curl -X POST "http://localhost:6888/powerfee/fetch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{}'
```

### 2. 调试推送

`debugPush` 为 `true` 时会忽略阈值，查询成功后立即发送一条 Telegram 测试消息。

```bash
curl -X POST "http://localhost:6888/powerfee/fetch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"debugPush":true}'
```

### 3. 使用查询参数传递访问令牌

适合临时浏览器或简单脚本调试。

```bash
curl -X POST "http://localhost:6888/powerfee/fetch?accessToken=<ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"debugPush":true}'
```

### 4. 临时覆盖宿舍信息

用于验证新的宿舍栋和房间号。服务会自动查询对应的门户内部编号。

```bash
curl -X POST "http://localhost:6888/powerfee/fetch" \
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

## GitHub Actions 自动部署

在 GitHub 仓库的 `Settings`、`Secrets and variables`、`Actions` 中添加以下 Secrets：

| Secret | 说明 |
| --- | --- |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID |
| `TENCENTCLOUD_SECRET_ID` | 腾讯云 API SecretId |
| `TENCENTCLOUD_SECRET_KEY` | 腾讯云 API SecretKey |
| `TENCENTCLOUD_SESSION_TOKEN` | 临时密钥 Token，使用长期密钥时留空 |

推送到 `main` 分支后会自动部署 CloudBase 函数。手动验证 Vercel 定时接口时使用同一个密钥：

```bash
curl -X GET "https://<your-vercel-domain>/powerfee/cron" \
  -H "Authorization: Bearer <CRON_SECRET>"
```
