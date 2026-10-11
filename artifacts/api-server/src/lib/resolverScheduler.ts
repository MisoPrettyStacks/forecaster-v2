import { resolveDueForecasts } from "./forecastPipeline";
import { logger } from "./logger";

let started = false;

/**
 * Keeps the track record current on its own: every 10 minutes while the
 * service is awake, settle any forecasts whose deadline has passed.
 * (Free-tier naps pause the loop; it catches up on wake.)
 */
export function startResolverScheduler(): void {
  if (started) return;
  if (process.env.DISABLE_SCHEDULER === "1") {
    logger.info("resolver scheduler disabled by DISABLE_SCHEDULER");
    return;
  }
  started = true;
  const tick = async () => {
    try {
      const result = await resolveDueForecasts(10);
      if (result.checked > 0) {
        logger.info(result, "auto-resolution tick");
      }
    } catch (err) {
      logger.error({ err }, "auto-resolution tick failed");
    }
  };
  void tick();
  setInterval(tick, 10 * 60 * 1000);
  logger.info("resolver scheduler started (10-minute ticks)");
}
