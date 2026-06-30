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
let webhookConfigured = false;

function normalizeUrl(value: string): string {
  const trimmedValue = value.trim();
  return trimmedValue.startsWith("http://") || trimmedValue.startsWith("https://") ? trimmedValue : `https://${trimmedValue}`;
}

function resolveVercelBaseUrl(): string | null {
  const url = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  return url ? normalizeUrl(url) : null;
}

function configureServerlessWebhook(notifier: TelegramNotifier, logger: Logger): void {
  if (webhookConfigured || !process.env.VERCEL || process.env.VERCEL_ENV === "preview") {
    return;
  }

  const baseUrl = resolveVercelBaseUrl();
  if (!baseUrl) {
    logger.warn("Telegram webhook auto configure skipped: Vercel URL is unavailable.");
    return;
  }

  webhookConfigured = true;
  void notifier.configureWebhook(baseUrl).catch((error: unknown) => {
    webhookConfigured = false;
    const message = error instanceof Error ? error.message : "Telegram webhook auto configure failed.";
    logger.error(message);
  });
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
  configureServerlessWebhook(telegramNotifier, logger);
  serverlessApp = createApp(powerFeeMonitor, logger, telegramNotifier).app;
  return serverlessApp;
}

export default function handler(request: Request, response: Response): void {
  getServerlessApp()(request, response);
}
