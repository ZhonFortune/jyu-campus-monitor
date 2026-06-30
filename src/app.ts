import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { createPowerFeeRouter } from "./routes/powerfee.js";
import { createErrorHandler, HttpError } from "./shared/error.js";
import { createHttpLogger, Logger } from "./shared/logger.js";
import type { PowerFeeMonitor } from "./services/powerfee/monitor.js";
import { createPowerFeeRuntime } from "./services/powerfee/runtime.js";
import type { TelegramNotifier } from "./services/telegram/notifier.js";

let serverlessApp: Express | null = null;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return readString(value[0]);
  }

  return readString(value);
}

function readAdminToken(request: Request): string | undefined {
  const authorization = readHeaderValue(request.headers.authorization);
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return readHeaderValue(request.headers["x-access-token"]) ?? readString(request.query.accessToken) ?? readString(request.query.cronSecret);
}

function assertTelegramAdminAuthorized(request: Request): void {
  const expectedToken = env.accessToken ?? env.cronSecret;
  if (!expectedToken) {
    throw new HttpError(503, "TELEGRAM_ADMIN_TOKEN_NOT_CONFIGURED", "Telegram 管理令牌未配置。");
  }

  if (readAdminToken(request) !== expectedToken) {
    throw new HttpError(401, "UNAUTHORIZED", "Telegram 管理令牌无效。");
  }
}

export function createApp(monitor?: PowerFeeMonitor, logger = new Logger(env.logLevel), telegramNotifier?: TelegramNotifier) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(createHttpLogger(logger));

  app.use(healthRouter);
  if (telegramNotifier) {
    app.all("/telegram/webhook/configure", async (request, response, next) => {
      try {
        assertTelegramAdminAuthorized(request);
        const status = await telegramNotifier.configureWebhook();
        const webhook = status === "disabled" ? null : await telegramNotifier.getWebhookInfo();

        response.status(200).json({
          status,
          webhook
        });
      } catch (error) {
        next(error);
      }
    });

    app.post("/telegram/webhook", async (request, response, next) => {
      try {
        await telegramNotifier.handleWebhookUpdate(request.body, request.headers["x-telegram-bot-api-secret-token"]);
        response.status(204).send();
      } catch (error) {
        next(error);
      }
    });
  }

  if (monitor) {
    app.use(createPowerFeeRouter(monitor));
  }

  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "Resource not found."));
  });

  app.use(createErrorHandler(logger));

  return { app, logger };
}

function getServerlessApp(): Express {
  if (serverlessApp) {
    return serverlessApp;
  }

  const { logger, powerFeeMonitor, telegramNotifier } = createPowerFeeRuntime();
  void telegramNotifier.configureWebhook().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Telegram webhook configure failed.";
    logger.error(message);
  });

  serverlessApp = createApp(powerFeeMonitor, logger, telegramNotifier).app;
  return serverlessApp;
}

export default function handler(request: Request, response: Response): void {
  getServerlessApp()(request, response);
}
