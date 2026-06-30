# JYU - CAMPUS - MONITOR

<center>

嘉应学院宿舍电费余额监控服务。每 1 h 触发一次余额查询，并在余额低于阈值时通过 Telegram 发送提醒。<strong>你可以点击下方 Deploy 字样按钮使用 Vercel 平台一键部署服务并使用 [Github Action 触发](#github-actions-定时触发)定时操作以避免 Vercel Hobby 方案的限制</strong>
<br>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor.git&project-name=jyu-campus-monitor&repository-name=jyu-campus-monitor&env=USE_CN_PROXY,CHINA_RELAY_URL,CHINA_RELAY_SECRET,ACCESS_TOKEN,CRON_SECRET,TELEGRAM_BOT_TOKEN,USERNAME,PASSWORD,DORM_BUILDING_NAME,ROOM_NUMBER,POWER_FEE_REMIND_THRESHOLD,POWER_FEE_REPEAT_THRESHOLD,TELEGRAM_WEBHOOK_SECRET&envDescription=%E9%85%8D%E7%BD%AE%E5%AE%BF%E8%88%8D%E7%94%B5%E8%B4%B9%E6%9F%A5%E8%AF%A2%E3%80%81CloudBase%20%E5%9B%9E%E5%9B%BD%E4%B8%AD%E7%BB%A7%E3%80%81Telegram%20%E6%8E%A8%E9%80%81%E3%80%81%E9%AA%8C%E8%AF%81%E7%A0%81%E7%99%BB%E5%BD%95%E5%92%8C%E5%AE%9A%E6%97%B6%E8%B0%83%E7%94%A8%E9%89%B4%E6%9D%83&envLink=https%3A%2F%2Fgithub.com%2FZhonFortune%2Fjyu-campus-monitor%23%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F)

[强密钥生成工具：用于填充ACCESS_TOKEN或CRON_SECRET](https://onetools.online/zh/token-generator?length=64&uppercase=true&lowercase=true&numbers=true&symbols=true)

</center>

> Vercel Hobby 不支持小时内多次执行的 Cron。服务部署在 Vercel，定时触发由 GitHub Actions 请求 `GET /powerfee/cron` 完成。因此，部署时需要配置 `CRON_SECRET` 环境变量以验证定时调用。
> 登录验证码通过 Telegram 发送。首次 `/start` 会注册会话、执行登录并查询一次电费余额；后续定时任务会复用内存登录态，登录态失效时自动重新登录并再次推送验证码。
> 一卡通接口访问通过 CloudBase 云函数 `china-relay` 作为国内中继节点完成。Vercel 将请求发送到 `CHINA_RELAY_URL`，云函数校验 `CHINA_RELAY_SECRET` 后传透请求与响应数据。

<br>

## 使用方法

1. 创建 Telegram Bot，获取 `TELEGRAM_BOT_TOKEN`<br>
2. Fork 本仓库<br>
3. 准备一卡通登录账号与密码，分别填写 `USERNAME` 和 `PASSWORD`<br>
4. 使用 [强密钥生成工具](https://onetools.online/zh/token-generator?length=64&uppercase=true&lowercase=true&numbers=true&symbols=true) 生成 `ACCESS_TOKEN`、`CRON_SECRET`、`CHINA_RELAY_SECRET`<br>
5. 在 CloudBase 中部署 `cloudbase/functions/china-relay` 云函数，并设置 `CHINA_RELAY_SECRET`<br>
6. 在 Vercel 中创建项目，并设置[环境变量](#环境变量)<br>
7. 向 Telegram 机器人发送 `/start`，根据图片输入 4 位验证码，完成登录并获取首次电费余额<br>
8. 在自己仓库的 Settings -> Secrets and variables > Actions > Repository secrets 中设置 `CRON_URL` 与 `CRON_SECRET` 两个变量<br>
> `CRON_URL` 为 Vercel 定时触发地址，例如 `https://jyu-campus-monitor.vercel.app/powerfee/cron` <br> `CRON_SECRET` 需要与 Vercel 项目中的 `CRON_SECRET` 变量值一致

<br>

随后 Deploy 项目即可。<strong>服务启动后不会自动登录；登录入口统一为 Telegram `/start` 登陆后将会保存登录状态，除非服务重启否则无需重新登录</strong>

<br>

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `PORT` | 本地服务端口 | `6888` | 否 |
| `LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` | `INFO` | 否 |
| `CORS_ORIGIN` | 跨域来源 | `*` | 否 |
| `USE_CN_PROXY` | 是否通过 CloudBase 国内中继访问一卡通接口 | `false` | 建议设置为 `true` |
| `CHINA_RELAY_URL` | CloudBase `china-relay` 云函数 HTTP 访问地址 | 无 | 使用中继时必填 |
| `CHINA_RELAY_SECRET` | Vercel 与 CloudBase 云函数之间的共享鉴权密钥 | 无 | Vercel 与 CloudBase 必填且值相同 |
| `ACCESS_TOKEN` | 手动调试接口访问令牌 | 无 | 否 |
| `CRON_SECRET` | 定时调用 `/powerfee/cron` 的鉴权密钥 | 无 | Vercel 与 GitHub Actions 必填 |
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人访问密钥 | 无 | 启用通知必填 |
| `TELEGRAM_WEBHOOK_URL` | Telegram Webhook 外部地址。Vercel 部署时默认读取 `VERCEL_URL`，本地轮询模式无需填写 | 无 | 否 |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Webhook 请求校验密钥。公网 Webhook 建议配置 | 无 | 否 |
| `USERNAME` | 一卡通登录账号 | 无 | 是 |
| `PASSWORD` | 一卡通登录密码 | 无 | 是 |
| `POWER_FEE_REMIND_THRESHOLD` | 首次提醒阈值，单位：元 | `20` | 否 |
| `POWER_FEE_REPEAT_THRESHOLD` | 二次提醒阈值，单位：元 | `10` | 否 |
| `DORM_BUILDING_NAME` | 宿舍栋名称 | 无 | 是 |
| `ROOM_NUMBER` | 房间号 | 无 | 是 |

CloudBase 云函数需设置：

| 变量 | 说明 | 默认值 | 必填 |
| --- | --- | --- | --- |
| `CHINA_RELAY_SECRET` | 与 Vercel `CHINA_RELAY_SECRET` 完全一致的共享鉴权密钥 | 无 | 是 |
| `ALLOWED_TARGET_HOSTS` | 允许中继访问的目标域名，英文逗号分隔 | `yktportal.jyu.edu.cn` | 否 |

<br>

## Telegram 通知

使用已存在的或新创建的 Telegram 机器人，配置 `TELEGRAM_BOT_TOKEN`。

> Telegram 机器人创建：[https://core.telegram.org/bots#6-botfather](https://core.telegram.org/bots#6-botfather)


使用自定义菜单添加以下已受支持的命令以完成快速操作

```text
/start  注册会话；未登录时执行登录并查询一次电费；已登录时查看运行状态
/left   已登录时查询当前电费余额
```

命令行为：

| 命令 | 行为 |
| --- | --- |
| `/start` | 注册 Telegram 会话。未登录时发送验证码图片，登录成功后缓存凭证并返回当前电费状态。已登录时直接返回“电费提醒已就绪”状态。 |
| `/left` | 未登录时提示先发送 `/start`。已登录时查询当前电费余额。 |

定时任务只在已有内存登录态后执行。若查询时发现登录态失效，服务会清理旧凭证、重新登录、重新发送验证码，并在登录成功后继续本次查询与阈值提醒。

<br>

## 本地开发

以下用例假设服务已运行在默认地址 `http://localhost:6888` 上，并且 `.env` 中已配置有效的 `ACCESS_TOKEN`、一卡通账号密码、宿舍栋名称和房间号。调试推送需要配置 `TELEGRAM_BOT_TOKEN` 并向机器人发送 `/start` 完成登录。

本地运行使用 Telegram long polling，不需要配置 `TELEGRAM_WEBHOOK_URL` 和 `TELEGRAM_WEBHOOK_SECRET`。

```bash
npm run dev
```

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

## GitHub Actions 定时触发

在 GitHub 仓库的 `Settings`、`Secrets and variables`、`Actions` 中添加以下 Secrets：

| Secret | 说明 |
| --- | --- |
| `CRON_URL` | Vercel 部署后的完整触发地址，例如 `https://<your-vercel-domain>/powerfee/cron` |
| `CRON_SECRET` | 与 Vercel 环境变量 `CRON_SECRET` 保持一致 |

工作流会每 1 h 自动请求一次 `CRON_URL`。手动验证时使用同一个密钥：

```bash
curl -X GET "https://<your-vercel-domain>/powerfee/cron" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## GitHub Actions 部署 CloudBase 中继

在 GitHub 仓库的 `Settings`、`Secrets and variables`、`Actions` 中添加以下 Secrets：

| Secret | 说明 |
| --- | --- |
| `TENCENT_SECRET_ID` | 腾讯云 API SecretId |
| `TENCENT_SECRET_KEY` | 腾讯云 API SecretKey |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID |

`Deploy CloudBase Relay` 工作流会在 `cloudbase/functions/china-relay/**` 或 `.github/workflows/cloudbase.yml` 变更后部署 `china-relay` 云函数，也可手动触发。
