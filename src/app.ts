import cors from "cors";
import express from "express";
import * as helmetModule from "helmet";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { createPowerFeeRouter } from "./routes/powerfee.js";
import { createErrorHandler, HttpError } from "./shared/error.js";
import { createHttpLogger, Logger } from "./shared/logger.js";
import { PowerFeeMonitor } from "./services/powerfee/monitor.js";

const helmet = helmetModule.default;

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
