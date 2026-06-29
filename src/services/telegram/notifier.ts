import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Telegraf } from "telegraf";
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

const SUBSCRIBER_STORE_PATH = path.join(process.cwd(), ".cache", "telegram", "subscribers.json");

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
  private started = false;

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

  async start(): Promise<boolean> {
    if (!this.bot) {
      return false;
    }

    if (this.started) {
      return true;
    }

    await this.loadSubscribers();
    this.logger.info(`Telegram bot starting | subscribers=${this.subscriberChatIds.size}`);

    this.bot.start(async (context) => {
      this.logger.info(`Telegram command received | command=/start | chatId=${context.chat.id}`);
      await this.registerChat(context.chat.id);
      const balance = await this.getBalanceOrNull();
      this.logger.info(`Telegram command balance resolved | command=/start | balance=${formatLogBalance(balance)}`);
      await context.reply(
        formatStatusMessage({
          dormBuildingName: this.status.dormBuildingName,
          roomNumber: this.status.roomNumber,
          remindThreshold: this.status.remindThreshold,
          repeatThreshold: this.status.repeatThreshold,
          balance
        })
      );
      this.logger.info(`Telegram command reply sent | command=/start | chatId=${context.chat.id} | balance=${formatLogBalance(balance)}`);
    });

    this.bot.command("left", async (context) => {
      this.logger.info(`Telegram command received | command=/left | chatId=${context.chat.id}`);
      try {
        const balance = await this.getBalance();
        this.logger.info(`Telegram command balance resolved | command=/left | balance=${formatLogBalance(balance)}`);
        await context.reply(
          formatBalanceMessage({
            dormBuildingName: this.status.dormBuildingName,
            roomNumber: this.status.roomNumber,
            balance
          })
        );
        this.logger.info(`Telegram command reply sent | command=/left | chatId=${context.chat.id} | balance=${formatLogBalance(balance)}`);
      } catch {
        this.logger.error(`Telegram command failed | command=/left | chatId=${context.chat.id}`);
        await context.reply("当前电费余额查询失败。");
      }
    });

    await this.bot.launch();
    this.started = true;
    this.logger.info("Telegram bot started.");
    return true;
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

    if (this.subscriberChatIds.size === 0) {
      throw new HttpError(409, "TELEGRAM_SUBSCRIBER_REQUIRED", "请先配置 TELEGRAM_CHAT_ID，或向 Telegram 机器人发送 /start。");
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

  private async registerChat(chatId: number | string): Promise<void> {
    this.subscriberChatIds.add(normalizeChatId(chatId));
    await this.saveSubscribers();
    this.logger.info(`Telegram subscriber registered | chatId=${chatId} | subscribers=${this.subscriberChatIds.size}`);
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

  private async getBalanceOrNull(): Promise<number | null> {
    try {
      return await this.getBalance();
    } catch {
      return null;
    }
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
}
