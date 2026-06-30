import { createApp } from "../src/app.js";
import { createPowerFeeRuntime } from "../src/services/powerfee/runtime.js";

const { logger, powerFeeMonitor, telegramNotifier } = createPowerFeeRuntime();
void telegramNotifier.configureWebhook().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Telegram webhook configure failed.";
  logger.error(message);
});

const { app } = createApp(powerFeeMonitor, logger, telegramNotifier);

export default app;
