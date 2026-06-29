import { Router, type Request } from "express";
import { env } from "../config/env.js";
import { HttpError } from "../shared/error.js";
import type { TelegramNotifier } from "../services/telegram/notifier.js";

type TelegramProxyBody = {
  message?: unknown;
  chatIds?: unknown;
  secret?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return readString(value[0]);
  }

  return readString(value);
}

function readProxySecret(request: Request, body: TelegramProxyBody | undefined): string | undefined {
  const authorization = readHeaderValue(request.headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return readHeaderValue(request.headers["x-telegram-proxy-secret"]) ?? readString(body?.secret);
}

function readMessage(value: unknown): string {
  const message = readString(value);
  if (!message) {
    throw new HttpError(400, "INVALID_TELEGRAM_MESSAGE", "消息内容不能为空。");
  }

  if (message.length > 4096) {
    throw new HttpError(400, "INVALID_TELEGRAM_MESSAGE", "消息内容过长。");
  }

  return message;
}

function readChatIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_TELEGRAM_CHAT_IDS", "接收会话格式无效。");
  }

  const chatIds = value.map(readString).filter((item): item is string => Boolean(item));
  if (chatIds.length === 0) {
    throw new HttpError(400, "INVALID_TELEGRAM_CHAT_IDS", "接收会话不能为空。");
  }

  return chatIds;
}

export function createTelegramRouter(notifier: TelegramNotifier) {
  const router = Router();

  router.post("/telegram/push", async (request, response, next) => {
    try {
      const body = request.body as TelegramProxyBody | undefined;

      if (!env.telegramProxySecret) {
        throw new HttpError(503, "TELEGRAM_PROXY_SECRET_NOT_CONFIGURED", "Telegram 推送密钥未配置。");
      }

      if (readProxySecret(request, body) !== env.telegramProxySecret) {
        throw new HttpError(401, "UNAUTHORIZED", "Telegram 推送密钥无效。");
      }

      const result = await notifier.sendProxyMessage(readMessage(body?.message), readChatIds(body?.chatIds));
      response.status(200).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
