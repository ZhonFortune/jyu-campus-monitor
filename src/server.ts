import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { Logger } from "./shared/logger.js";
import { createPowerFeeRuntime } from "./services/power-fee-runtime.js";

const bootstrapLogger = new Logger(env.logLevel);
const { powerFeeMonitor, telegramNotifier } = createPowerFeeRuntime(bootstrapLogger);
const { app, logger } = createApp(powerFeeMonitor, bootstrapLogger);

const server = app.listen(env.port, () => {
  logger.info(`Server listening on port ${env.port}`);
  void startTelegram();
  powerFeeMonitor.start();
});

async function startTelegram(): Promise<void> {
  try {
    const enabled = await telegramNotifier.start();
    if (!enabled) {
      logger.warn("Telegram bot token is not configured; notifications are disabled.");
      return;
    }

    const balance = await getStartupBalance();
    const healthCheckStatus = await telegramNotifier.sendStartupHealthCheck({
      dormBuildingName: env.dormBuildingName,
      roomNumber: env.roomNumber,
      remindThreshold: env.powerFeeRemindThreshold,
      repeatThreshold: env.powerFeeRepeatThreshold,
      balance
    });

    if (healthCheckStatus === "sent") {
      logger.info("Telegram startup health check sent.");
      return;
    }

    if (healthCheckStatus === "no_subscriber") {
      logger.warn("Telegram startup health check skipped: no subscriber. Send /start to the bot first.");
      return;
    }

    logger.warn(`Telegram startup health check skipped: ${healthCheckStatus}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram bot failed to start.";
    logger.error(message);
  }
}

async function getStartupBalance(): Promise<number | null> {
  try {
    return await powerFeeMonitor.getCurrentBalance();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Startup balance check failed.";
    logger.warn(`Telegram startup health check balance skipped: ${message}`);
    return null;
  }
}

function shutdown(signal: NodeJS.Signals): void {
  logger.info(`Received ${signal}, shutting down`);
  powerFeeMonitor.stop();
  telegramNotifier.stop(signal);
  server.close((error) => {
    if (error) {
      logger.error(`Shutdown failed: ${error.message}`);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
