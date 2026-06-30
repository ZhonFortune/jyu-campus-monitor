import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { HttpError } from "../../shared/error.js";
import type { Logger } from "../../shared/logger.js";

export type PowerFeeNotification = {
  balance: number;
  dormBuildingName: string;
  roomNumber: string;
  remindThreshold: number;
  repeatThreshold: number;
  reason: "remind" | "repeat" | "debug";
};

export type StartupHealthNotification = {
  dormBuildingName: string;
  roomNumber: string;
  remindThreshold: number;
  repeatThreshold: number;
  balance: number | null;
};

export type TelegramStatusConfig = {
  dormBuildingName: string;
  roomNumber: string;
  remindThreshold: number;
  repeatThreshold: number;
};

type BalanceProvider = () => Promise<number>;
type LoginProvider = () => Promise<number>;
type LoginStatusProvider = () => boolean;
type PendingCaptcha = {
  chatIds: ReadonlySet<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const SUBSCRIBER_STORE_PATH = path.join(process.cwd(), ".cache", "telegram", "subscribers.json");
const CAPTCHA_TIMEOUT_MS = 2 * 60 * 1000;
const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";

function formatAmount(value: number): string {
  return value.toFixed(2);
}

function formatCurrency(value: number): string {
  return `${formatAmount(value)} 元`;
}

function formatLogBalance(value: number | null): string {
  return value === null ? "unavailable" : formatCurrency(value);
}

function normalizeChatId(value: number | string): string {
  return String(value).trim();
}

function normalizeCaptchaCode(value: string): string | null {
  const code = value
    .trim()
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xff10 + 0x30));

  return /^\d{4}$/.test(code) ? code : null;
}

function buildTelegramWebhookUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  return normalizedBaseUrl.endsWith(TELEGRAM_WEBHOOK_PATH) ? normalizedBaseUrl : `${normalizedBaseUrl}${TELEGRAM_WEBHOOK_PATH}`;
}

function formatStatusMessage(notification: StartupHealthNotification): string {
  const balance = notification.balance === null ? "待查询" : formatCurrency(notification.balance);

  return [
    "电费提醒已就绪",
    `宿舍楼：${notification.dormBuildingName}`,
    `房间号：${notification.roomNumber}`,
    "",
    `首次提醒阈值：${formatCurrency(notification.remindThreshold)}`,
    `二次提醒阈值：${formatCurrency(notification.repeatThreshold)}`,
    `当前电费余额：${balance}`,
    "",
    "服务运行中"
  ].join("\n");
}

function formatBalanceMessage(notification: Pick<StartupHealthNotification, "dormBuildingName" | "roomNumber"> & { balance: number }): string {
  return [
    "当前电费余额",
    `宿舍楼：${notification.dormBuildingName}`,
    `房间号：${notification.roomNumber}`,
    "",
    `余额：${formatCurrency(notification.balance)}`,
    "",
    "查询成功"
  ].join("\n");
}

function formatThresholdAlertMessage(notification: PowerFeeNotification): string {
  const alertName = notification.reason === "repeat" ? "二次" : "首次";
  const threshold = notification.reason === "repeat" ? notification.repeatThreshold : notification.remindThreshold;

  return [
    `电费余额触发${alertName}提醒`,
    `宿舍楼：${notification.dormBuildingName}`,
    `房间号：${notification.roomNumber}`,
    "",
    `当前余额：${formatCurrency(notification.balance)}`,
    `提醒阈值：${formatCurrency(threshold)}`,
    "",
    "请及时充值"
  ].join("\n");
}

export class TelegramNotifier {
  private readonly bot: Telegraf | null;
  private readonly subscriberChatIds = new Set<string>();
  private balanceProvider: BalanceProvider | null = null;
  private loginProvider: LoginProvider | null = null;
  private loginStatusProvider: LoginStatusProvider | null = null;
  private started = false;
  private handlersRegistered = false;
  private subscribersLoadedPromise: Promise<void> | null = null;
  private webhookConfiguredPromise: Promise<void> | null = null;
  private loginPromise: Promise<number> | null = null;
  private lastBalance: number | null = null;
  private pendingCaptcha: PendingCaptcha | null = null;

  constructor(
    token: string | null,
    private readonly status: TelegramStatusConfig,
    private readonly logger: Logger,
    subscriberChatIds: readonly string[] = []
  ) {
    this.bot = token ? new Telegraf(token) : null;

    for (const chatId of subscriberChatIds) {
      const normalizedChatId = normalizeChatId(chatId);
      if (normalizedChatId) {
        this.subscriberChatIds.add(normalizedChatId);
      }
    }
  }

  setBalanceProvider(balanceProvider: BalanceProvider): void {
    this.balanceProvider = balanceProvider;
  }

  setLoginProvider(loginProvider: LoginProvider, loginStatusProvider: LoginStatusProvider): void {
    this.loginProvider = loginProvider;
    this.loginStatusProvider = loginStatusProvider;
  }

  async start(): Promise<boolean> {
    if (!this.bot) {
      return false;
    }

    if (this.started) {
      return true;
    }

    await this.ensureSubscribersLoaded();
    this.logger.info(`Telegram bot starting | subscribers=${this.subscriberChatIds.size}`);
    this.registerHandlers();

    await this.bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await this.bot.launch();
    this.started = true;
    this.logger.info("Telegram bot started.");
    return true;
  }

  async handleWebhookUpdate(update: unknown, secretToken: string | string[] | undefined): Promise<void> {
    if (!this.bot) {
      throw new HttpError(409, "TELEGRAM_DISABLED", "Telegram 机器人未配置。");
    }

    const receivedSecretToken = Array.isArray(secretToken) ? secretToken[0] : secretToken;
    if (env.telegramWebhookSecret && receivedSecretToken !== env.telegramWebhookSecret) {
      throw new HttpError(401, "UNAUTHORIZED", "Telegram webhook 密钥无效。");
    }

    await this.ensureSubscribersLoaded();
    this.registerHandlers();
    await this.bot.handleUpdate(update as never);
  }

  async configureWebhook(): Promise<"disabled" | "skipped" | "configured"> {
    if (!this.bot) {
      return "disabled";
    }

    if (!env.telegramWebhookUrl) {
      return "skipped";
    }

    if (!this.webhookConfiguredPromise) {
      const webhookOptions = env.telegramWebhookSecret
        ? { secret_token: env.telegramWebhookSecret, drop_pending_updates: false }
        : { drop_pending_updates: false };

      this.webhookConfiguredPromise = this.bot.telegram
        .setWebhook(buildTelegramWebhookUrl(env.telegramWebhookUrl), webhookOptions)
        .then(() => {
          this.logger.info("Telegram webhook configured.");
        });
    }

    await this.webhookConfiguredPromise;
    return "configured";
  }

  stop(reason: string): void {
    if (!this.bot || !this.started) {
      return;
    }

    this.bot.stop(reason);
    this.started = false;
  }

  async sendPowerFeeAlert(notification: PowerFeeNotification): Promise<void> {
    if (!this.bot) {
      throw new HttpError(409, "TELEGRAM_DISABLED", "Telegram 机器人未配置。");
    }

    await this.ensureSubscribersLoaded();

    if (this.subscriberChatIds.size === 0) {
      throw new HttpError(409, "TELEGRAM_SUBSCRIBER_REQUIRED", "请先向 Telegram 机器人发送 /start。");
    }

    const message =
      notification.reason === "debug"
        ? formatStatusMessage({
            dormBuildingName: notification.dormBuildingName,
            roomNumber: notification.roomNumber,
            remindThreshold: notification.remindThreshold,
            repeatThreshold: notification.repeatThreshold,
            balance: notification.balance
          })
        : formatThresholdAlertMessage(notification);

    this.logger.info(
      [
        "Telegram push requested",
        `reason=${notification.reason}`,
        `balance=${formatLogBalance(notification.balance)}`,
        `subscribers=${this.subscriberChatIds.size}`
      ].join(" | ")
    );
    const sent = await this.sendToSubscribers(message);

    if (!sent) {
      this.logger.error(`Telegram push failed | reason=${notification.reason} | balance=${formatLogBalance(notification.balance)}`);
      throw new HttpError(502, "TELEGRAM_SEND_FAILED", "Telegram 消息发送失败。");
    }

    this.logger.info(`Telegram push sent | reason=${notification.reason} | balance=${formatLogBalance(notification.balance)}`);
  }

  async sendStartupHealthCheck(notification: StartupHealthNotification): Promise<"disabled" | "no_subscriber" | "sent" | "failed"> {
    if (!this.bot) {
      return "disabled";
    }

    await this.ensureSubscribersLoaded();

    if (this.subscriberChatIds.size === 0) {
      return "no_subscriber";
    }

    const message = formatStatusMessage(notification);
    this.logger.info(
      `Telegram startup health check push requested | balance=${formatLogBalance(notification.balance)} | subscribers=${this.subscriberChatIds.size}`
    );

    const sent = await this.sendToSubscribers(message);
    this.logger.info(`Telegram startup health check push result | sent=${sent} | balance=${formatLogBalance(notification.balance)}`);
    return sent ? "sent" : "failed";
  }

  async requestCaptcha(image: Buffer): Promise<string> {
    if (!this.bot) {
      throw new HttpError(409, "TELEGRAM_DISABLED", "Telegram 机器人未配置。");
    }

    await this.ensureSubscribersLoaded();
    this.registerHandlers();

    if (this.subscriberChatIds.size === 0) {
      throw new HttpError(409, "TELEGRAM_SUBSCRIBER_REQUIRED", "请先向 Telegram 机器人发送 /start。");
    }

    if (this.pendingCaptcha) {
      clearTimeout(this.pendingCaptcha.timeout);
      this.pendingCaptcha.reject(new Error("Captcha request replaced."));
      this.pendingCaptcha = null;
    }

    const captchaChatIds = new Set(this.subscriberChatIds);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingCaptcha?.timeout === timeout) {
          this.pendingCaptcha = null;
        }
        reject(new HttpError(408, "TELEGRAM_CAPTCHA_TIMEOUT", "验证码输入超时。"));
      }, CAPTCHA_TIMEOUT_MS);

      const pendingCaptcha: PendingCaptcha = {
        chatIds: captchaChatIds,
        resolve,
        reject,
        timeout
      };
      this.pendingCaptcha = pendingCaptcha;

      void this.sendCaptchaToSubscribers(image, captchaChatIds)
        .then((sent) => {
          if (!sent && this.pendingCaptcha === pendingCaptcha) {
            clearTimeout(timeout);
            this.pendingCaptcha = null;
            reject(new HttpError(502, "TELEGRAM_CAPTCHA_SEND_FAILED", "验证码发送失败。"));
            return;
          }

          this.logger.info(`Telegram captcha requested | subscribers=${this.subscriberChatIds.size}`);
        })
        .catch((error: unknown) => {
          if (this.pendingCaptcha !== pendingCaptcha) {
            return;
          }

          clearTimeout(timeout);
          this.pendingCaptcha = null;
          const message = error instanceof Error ? error.message : "Captcha send failed.";
          reject(new HttpError(502, "TELEGRAM_CAPTCHA_SEND_FAILED", message));
        });
    });
  }

  private registerHandlers(): void {
    if (!this.bot || this.handlersRegistered) {
      return;
    }

    this.handlersRegistered = true;

    this.bot.start(async (context) => {
      this.logger.info(`Telegram command received | command=/start | chatId=${context.chat.id}`);
      await this.registerChat(context.chat.id);

      if (this.isLoggedIn()) {
        await context.reply(
          formatStatusMessage({
            dormBuildingName: this.status.dormBuildingName,
            roomNumber: this.status.roomNumber,
            remindThreshold: this.status.remindThreshold,
            repeatThreshold: this.status.repeatThreshold,
            balance: this.lastBalance
          })
        );
        this.logger.info(`Telegram command reply sent | command=/start | chatId=${context.chat.id} | reason=session_ready`);
        return;
      }

      if (this.loginPromise) {
        await context.reply("登录处理中，请稍后");
        this.logger.info(`Telegram command reply sent | command=/start | chatId=${context.chat.id} | reason=login_pending`);
        return;
      }

      await context.reply("正在获取登录接口，请稍后");
      void this.loginAndReply(context.chat.id);
    });

    this.bot.command("left", async (context) => {
      this.logger.info(`Telegram command received | command=/left | chatId=${context.chat.id}`);
      if (!this.isLoggedIn()) {
        await context.reply("请先发送 /start 完成登录");
        this.logger.info(`Telegram command reply sent | command=/left | chatId=${context.chat.id} | reason=session_required`);
        return;
      }

      await context.reply("电费提醒信息获取中");
      void this.replyBalance(context.chat.id);
    });

    this.bot.on("text", async (context) => {
      const text = context.message.text.trim();
      const chatId = normalizeChatId(context.chat.id);
      if (text.startsWith("/")) {
        return;
      }

      const pendingCaptcha = this.pendingCaptcha;
      if (!pendingCaptcha) {
        this.logger.info(`Telegram text ignored | chatId=${chatId} | reason=no_pending_captcha`);
        await context.reply("当前没有待处理的验证码");
        return;
      }

      if (!pendingCaptcha.chatIds.has(chatId)) {
        this.logger.info(`Telegram text ignored | chatId=${chatId} | reason=chat_not_requested`);
        await context.reply("当前会话没有待处理的验证码");
        return;
      }

      const code = normalizeCaptchaCode(text);
      if (!code) {
        this.logger.info(`Telegram text rejected | chatId=${chatId} | reason=invalid_captcha_code`);
        await context.reply("请输入 4 位数字验证码");
        return;
      }

      this.pendingCaptcha = null;
      clearTimeout(pendingCaptcha.timeout);
      pendingCaptcha.resolve(code);
      await context.reply("登陆中，请稍候");
      this.logger.info(`Telegram captcha received | chatId=${chatId}`);
    });
  }

  private isLoggedIn(): boolean {
    return this.loginStatusProvider?.() ?? false;
  }

  private async registerChat(chatId: number | string): Promise<void> {
    this.subscriberChatIds.add(normalizeChatId(chatId));
    await this.saveSubscribers();
    this.logger.info(`Telegram subscriber registered | chatId=${chatId} | subscribers=${this.subscriberChatIds.size}`);
  }

  private async loginAndReply(chatId: number | string): Promise<void> {
    const bot = this.bot;
    if (!bot) {
      return;
    }

    if (!this.loginProvider) {
      await bot.telegram.sendMessage(chatId, "登录服务未就绪");
      return;
    }

    try {
      this.loginPromise = this.loginProvider().finally(() => {
        this.loginPromise = null;
      });
      const balance = await this.loginPromise;
      this.lastBalance = balance;
      await bot.telegram.sendMessage(
        chatId,
        formatStatusMessage({
          dormBuildingName: this.status.dormBuildingName,
          roomNumber: this.status.roomNumber,
          remindThreshold: this.status.remindThreshold,
          repeatThreshold: this.status.repeatThreshold,
          balance
        })
      );
      this.logger.info(`Telegram login completed | chatId=${chatId} | balance=${formatLogBalance(balance)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";
      this.logger.error(`Telegram login failed | chatId=${chatId} | cause=${message}`);
      await bot.telegram.sendMessage(chatId, "登录失败，请检查代理或账号密码是否正确");
    }
  }

  private async replyBalance(chatId: number | string): Promise<void> {
    const bot = this.bot;
    if (!bot) {
      return;
    }

    try {
      const balance = await this.getBalance();
      this.lastBalance = balance;
      this.logger.info(`Telegram command balance resolved | command=/left | balance=${formatLogBalance(balance)}`);
      await bot.telegram.sendMessage(
        chatId,
        formatBalanceMessage({
          dormBuildingName: this.status.dormBuildingName,
          roomNumber: this.status.roomNumber,
          balance
        })
      );
      this.logger.info(`Telegram command reply sent | command=/left | chatId=${chatId} | balance=${formatLogBalance(balance)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Balance query failed.";
      this.logger.error(`Telegram command failed | command=/left | chatId=${chatId} | cause=${message}`);
      await bot.telegram.sendMessage(chatId, "当前电费余额查询失败");
    }
  }

  private async ensureSubscribersLoaded(): Promise<void> {
    if (!this.subscribersLoadedPromise) {
      this.subscribersLoadedPromise = this.loadSubscribers();
    }

    await this.subscribersLoadedPromise;
  }

  private async loadSubscribers(): Promise<void> {
    try {
      const text = await readFile(SUBSCRIBER_STORE_PATH, "utf8");
      const payload = JSON.parse(text) as unknown;

      if (!Array.isArray(payload)) {
        return;
      }

      for (const value of payload) {
        if (typeof value === "string" || typeof value === "number") {
          const chatId = normalizeChatId(value);
          if (chatId) {
            this.subscriberChatIds.add(chatId);
          }
        }
      }
      this.logger.info(`Telegram subscribers loaded | subscribers=${this.subscriberChatIds.size}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.logger.info(`Telegram subscribers loaded | subscribers=${this.subscriberChatIds.size}`);
        return;
      }

      throw error;
    }
  }

  private async saveSubscribers(): Promise<void> {
    await mkdir(path.dirname(SUBSCRIBER_STORE_PATH), { recursive: true });
    await writeFile(SUBSCRIBER_STORE_PATH, JSON.stringify(Array.from(this.subscriberChatIds), null, 2), "utf8");
  }

  private async getBalance(): Promise<number> {
    if (!this.balanceProvider) {
      throw new HttpError(409, "BALANCE_PROVIDER_REQUIRED", "余额查询服务未就绪。");
    }

    return this.balanceProvider();
  }

  private async sendToSubscribers(message: string): Promise<boolean> {
    const bot = this.bot;
    if (!bot) {
      return false;
    }

    const results = await Promise.allSettled(
      Array.from(this.subscriberChatIds).map((chatId) => bot.telegram.sendMessage(chatId, message))
    );
    const sentCount = results.filter((result) => result.status === "fulfilled").length;
    const failedCount = results.length - sentCount;
    this.logger.info(`Telegram send batch completed | sent=${sentCount} | failed=${failedCount}`);

    return results.some((result) => result.status === "fulfilled");
  }

  private async sendCaptchaToSubscribers(image: Buffer, chatIds: ReadonlySet<string>): Promise<boolean> {
    const bot = this.bot;
    if (!bot) {
      return false;
    }

    const results = await Promise.allSettled(
      Array.from(chatIds).map((chatId) =>
        bot.telegram.sendPhoto(chatId, { source: image }, {
          caption: `请直接回复本消息中的 4 位数字\n当前账号：${env.username}`,
          reply_markup: {
            force_reply: true,
            input_field_placeholder: "输入 4 位验证码"
          }
        })
      )
    );
    const sentCount = results.filter((result) => result.status === "fulfilled").length;
    const failedCount = results.length - sentCount;
    this.logger.info(`Telegram captcha send batch completed | sent=${sentCount} | failed=${failedCount}`);

    return results.some((result) => result.status === "fulfilled");
  }
}
