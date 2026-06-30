import { createApp } from "../src/app.js";
import { createPowerFeeRuntime } from "../src/services/powerfee/runtime.js";

const { logger, powerFeeMonitor } = createPowerFeeRuntime();
const { app } = createApp(powerFeeMonitor, logger);

export default app;
