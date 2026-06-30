import { env } from "../../config/env.js";
import { Logger } from "../../shared/logger.js";
import { getState, setState } from "../../shared/state-store.js";
import { TelegramNotifier } from "../telegram/notifier.js";
import { PowerFeeClient, type PowerFeeBalance, type PowerFeeLocation } from "./client.js";

const MIN_INTERVAL_MS = 30 * 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;
const ALERT_STATE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export type ManualPowerFeeCheckOptions = {
  debugPush: boolean;
  location?: Partial<PowerFeeLocation>;
};

export type PowerFeeCheckResult = {
  balance: number;
  reminded: boolean;
  repeated: boolean;
  debugPushed: boolean;
  nextRunAt: string | null;
  raw: unknown;
};

type AlertState = {
  reminderSent: boolean;
  repeatReminderSent: boolean;
};

export class PowerFeeMonitor {
  private timer: NodeJS.Timeout | null = null;
  private reminderSent = false;
  private repeatReminderSent = false;
  private nextRunAt: Date | null = null;

  constructor(
    private readonly client: PowerFeeClient,
    private readonly notifier: TelegramNotifier,
    private readonly logger: Logger
  ) {}

  start(): void {
    this.scheduleNextRun();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.nextRunAt = null;
  }

  async runManualCheck(options: ManualPowerFeeCheckOptions): Promise<PowerFeeCheckResult> {
    return this.check(options);
  }

  async getCurrentBalance(options?: { location?: Partial<PowerFeeLocation> }): Promise<number> {
    const location = buildLocation(options?.location);
    this.logger.info(`Power fee balance query started | source=command | dorm=${location.dormBuildingName} | room=${location.roomNumber}`);
    const balanceResult = await this.client.getBalance(location);
    this.logger.info(`Power fee balance query completed | source=command | balance=${balanceResult.balance.toFixed(2)}`);
    return balanceResult.balance;
  }

  async createLoginCaptcha(): Promise<Buffer> {
    return this.client.createLoginChallenge();
  }

  async completeLoginCaptcha(captchaCode: string): Promise<number> {
    await this.client.completeLoginChallenge(captchaCode);
    return this.getCurrentBalance();
  }

  async initializeSession(): Promise<void> {
    await this.client.initializeSession();
  }

  isSessionReady(): boolean {
    return this.client.isSessionReady();
  }

  private scheduleNextRun(): void {
    const delay = randomDelay();
    this.nextRunAt = new Date(Date.now() + delay);
    this.timer = setTimeout(() => {
      void this.runScheduledCheck();
    }, delay);
  }

  private async runScheduledCheck(): Promise<void> {
    try {
      if (!this.client.isSessionReady()) {
        this.logger.info("Power fee monitor skipped: session not initialized.");
        return;
      }

      await this.check({ debugPush: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown monitor error.";
      this.logger.error(`Power fee monitor failed: ${message}`);
    } finally {
      this.scheduleNextRun();
    }
  }

  private async check(options: ManualPowerFeeCheckOptions): Promise<PowerFeeCheckResult> {
    const location = buildLocation(options.location);
    const dormBuildingName = location.dormBuildingName;
    const roomNumber = location.roomNumber;
    this.logger.info(
      `Power fee balance query started | source=${options.debugPush ? "manual-debug" : "scheduled"} | dorm=${dormBuildingName} | room=${roomNumber}`
    );
    const balanceResult = await this.client.getBalance(location);
    this.logger.info(
      `Power fee balance query completed | source=${options.debugPush ? "manual-debug" : "scheduled"} | balance=${balanceResult.balance.toFixed(2)}`
    );

    if (options.debugPush) {
      await this.notifier.sendPowerFeeAlert({
        balance: balanceResult.balance,
        dormBuildingName,
        roomNumber,
        remindThreshold: env.powerFeeRemindThreshold,
        repeatThreshold: env.powerFeeRepeatThreshold,
        reason: "debug"
      });
      this.logger.info(`Power fee debug push action completed | balance=${balanceResult.balance.toFixed(2)}`);
    }

    const alertState = await this.applyThresholdRules(balanceResult, dormBuildingName, roomNumber);

    return {
      balance: balanceResult.balance,
      reminded: alertState.reminded,
      repeated: alertState.repeated,
      debugPushed: options.debugPush,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
      raw: balanceResult.raw
    };
  }

  private async applyThresholdRules(
    balanceResult: PowerFeeBalance,
    dormBuildingName: string,
    roomNumber: string
  ): Promise<{ reminded: boolean; repeated: boolean }> {
    const { balance } = balanceResult;
    const alertStateKey = buildAlertStateKey(dormBuildingName, roomNumber);
    const persistedState = await getState<AlertState>(alertStateKey);
    const reminderSent = persistedState?.reminderSent ?? this.reminderSent;
    const repeatReminderSent = persistedState?.repeatReminderSent ?? this.repeatReminderSent;
    this.logger.info(
      [
        "Power fee threshold evaluated",
        `balance=${balance.toFixed(2)}`,
        `remindThreshold=${env.powerFeeRemindThreshold.toFixed(2)}`,
        `repeatThreshold=${env.powerFeeRepeatThreshold.toFixed(2)}`,
        `reminderSent=${reminderSent}`,
        `repeatReminderSent=${repeatReminderSent}`
      ].join(" | ")
    );

    if (balance >= env.powerFeeRemindThreshold) {
      if (reminderSent || repeatReminderSent) {
        this.logger.info(`Power fee threshold state reset | balance=${balance.toFixed(2)}`);
      }
      await this.saveAlertState(alertStateKey, { reminderSent: false, repeatReminderSent: false });
      return { reminded: false, repeated: false };
    }

    let reminded = false;
    let repeated = false;
    let nextState: AlertState = { reminderSent, repeatReminderSent };
    const reminderWasAlreadySent = reminderSent;

    if (!reminderSent) {
      this.logger.info(`Power fee first threshold action triggered | balance=${balance.toFixed(2)}`);
      await this.notifier.sendPowerFeeAlert({
        balance,
        dormBuildingName,
        roomNumber,
        remindThreshold: env.powerFeeRemindThreshold,
        repeatThreshold: env.powerFeeRepeatThreshold,
        reason: "remind"
      });
      nextState = { ...nextState, reminderSent: true };
      reminded = true;
      this.logger.info(`Power fee first threshold action completed | balance=${balance.toFixed(2)}`);
    }

    if (reminderWasAlreadySent && balance < env.powerFeeRepeatThreshold && !repeatReminderSent) {
      this.logger.info(`Power fee repeat threshold action triggered | balance=${balance.toFixed(2)}`);
      for (let index = 0; index < 3; index += 1) {
        await this.notifier.sendPowerFeeAlert({
          balance,
          dormBuildingName,
          roomNumber,
          remindThreshold: env.powerFeeRemindThreshold,
          repeatThreshold: env.powerFeeRepeatThreshold,
          reason: "repeat"
        });
      }

      nextState = { ...nextState, repeatReminderSent: true };
      repeated = true;
      this.logger.info(`Power fee repeat threshold action completed | balance=${balance.toFixed(2)}`);
    }

    await this.saveAlertState(alertStateKey, nextState);
    return { reminded, repeated };
  }

  private async saveAlertState(key: string, state: AlertState): Promise<void> {
    this.reminderSent = state.reminderSent;
    this.repeatReminderSent = state.repeatReminderSent;
    await setState(key, state, { ttlMs: ALERT_STATE_TTL_MS });
  }
}

function buildLocation(location?: Partial<PowerFeeLocation>): PowerFeeLocation {
  return {
    schoolAreaNo: location?.schoolAreaNo?.trim() || env.schoolAreaNo,
    dormBuildingName: location?.dormBuildingName?.trim() || env.dormBuildingName,
    roomNumber: location?.roomNumber?.trim() || env.roomNumber
  };
}

function randomDelay(): number {
  const span = MAX_INTERVAL_MS - MIN_INTERVAL_MS;
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (span + 1));
}

function buildAlertStateKey(dormBuildingName: string, roomNumber: string): string {
  return `powerfee:alert:${env.schoolAreaNo}:${dormBuildingName}:${roomNumber}`;
}
