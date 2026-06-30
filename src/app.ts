import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { createPowerFeeRouter } from "./routes/powerfee.js";
import { createErrorHandler, HttpError } from "./shared/error.js";
import { createHttpLogger, Logger } from "./shared/logger.js";
import { PowerFeeMonitor } from "./services/powerfee/monitor.js";
import { TelegramNotifier } from "./services/telegram/notifier.js";

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
