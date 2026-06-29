import { createPowerFeeRuntime } from "../services/powerfee/runtime.js";

type CloudBaseEvent = Record<string, unknown>;
type CloudBaseContext = Record<string, unknown>;

export async function main(event: CloudBaseEvent = {}, context: CloudBaseContext = {}) {
  const { logger, powerFeeMonitor } = createPowerFeeRuntime();

  logger.info(
    [
      "CloudBase scheduled power fee check started",
      `eventKeys=${Object.keys(event).join(",") || "none"}`,
      `contextKeys=${Object.keys(context).join(",") || "none"}`
    ].join(" | ")
  );

  const result = await powerFeeMonitor.runManualCheck({ debugPush: false });

  logger.info(
    [
      "CloudBase scheduled power fee check completed",
      `balance=${result.balance.toFixed(2)}`,
      `reminded=${result.reminded}`,
      `repeated=${result.repeated}`
    ].join(" | ")
  );

  return {
    ok: true,
    balance: result.balance,
    reminded: result.reminded,
    repeated: result.repeated,
    debugPushed: result.debugPushed,
    nextRunAt: result.nextRunAt
  };
}
