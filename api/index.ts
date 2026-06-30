import { createApp } from "../src/app.js";
import { createPowerFeeRuntime } from "../src/services/powerfee/runtime.js";

const { logger, powerFeeMonitor, telegramNotifier } = createPowerFeeRuntime();
const { app } = createApp(powerFeeMonitor, logger, telegramNotifier);

export default app;
