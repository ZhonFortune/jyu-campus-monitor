import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import { createHttpLogger } from "./middleware/http-logger.js";
import { healthRouter } from "./routes/health.js";
import { createPowerFeeRouter } from "./routes/power-fee.js";
import { HttpError } from "./shared/http-error.js";
import { Logger } from "./shared/logger.js";
import { PowerFeeMonitor } from "./services/power-fee-monitor.js";

export function createApp(monitor?: PowerFeeMonitor, logger = new Logger(env.logLevel)) {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: "1mb" }));
  app.use(createHttpLogger(logger));

  app.use(healthRouter);
  if (monitor) {
    app.use(createPowerFeeRouter(monitor));
  }

  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "Resource not found."));
  });

  app.use(createErrorHandler(logger));

  return { app, logger };
}
