import { env } from "../config/env.js";
import { Logger } from "../shared/logger.js";
import { PowerFeeClient } from "./power-fee-client.js";
import { PowerFeeMonitor } from "./power-fee-monitor.js";
import { TelegramNotifier } from "./telegram-notifier.js";

export function createPowerFeeRuntime(logger = new Logger(env.logLevel)) {
  const telegramNotifier = new TelegramNotifier(
    env.telegramBotToken,
    {
      dormBuildingName: env.dormBuildingName,
      roomNumber: env.roomNumber,
      remindThreshold: env.powerFeeRemindThreshold,
      repeatThreshold: env.powerFeeRepeatThreshold
    },
    logger,
    env.telegramChatIds
  );
  const powerFeeMonitor = new PowerFeeMonitor(new PowerFeeClient(logger), telegramNotifier, logger);

  telegramNotifier.setBalanceProvider(() => powerFeeMonitor.getCurrentBalance());

  return {
    logger,
    powerFeeMonitor,
    telegramNotifier
  };
}
