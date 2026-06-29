import { createApp } from "../src/app.js";
import { createPowerFeeRuntime } from "../src/services/power-fee-runtime.js";

const { logger, powerFeeMonitor } = createPowerFeeRuntime();
const { app } = createApp(powerFeeMonitor, logger);

export default app;
