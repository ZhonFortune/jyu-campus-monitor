import { env } from "../../config/env.js";
import { Logger } from "../../shared/logger.js";
import { TelegramNotifier } from "../telegram/notifier.js";
import { PowerFeeClient } from "./client.js";
import { PowerFeeMonitor } from "./monitor.js";

export function createPowerFeeRuntime(logger = new Logger(env.logLevel)) {
  const telegramNotifier = new TelegramNotifier(
    env.telegramBotToken,
    {
      dormBuildingName: env.dormBuildingName,
      roomNumber: env.roomNumber,
      remindThreshold: env.powerFeeRemindThreshold,
      repeatThreshold: env.powerFeeRepeatThreshold
    },
    logger
  );
  const powerFeeClient = new PowerFeeClient(logger);
  powerFeeClient.setCaptchaResolver((image) => telegramNotifier.requestCaptcha(image));
  const powerFeeMonitor = new PowerFeeMonitor(powerFeeClient, telegramNotifier, logger);

  telegramNotifier.setBalanceProvider(() => powerFeeMonitor.getCurrentBalance());
  telegramNotifier.setLoginProvider(() => powerFeeMonitor.getCurrentBalance(), () => powerFeeMonitor.isSessionReady());

  return {
    logger,
    powerFeeMonitor,
    telegramNotifier
  };
}
