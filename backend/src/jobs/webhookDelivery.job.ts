import cron from "node-cron";
import { webhookService } from "../services/webhook.service";
import logger from "../utils/logger";

export function startWebhookDeliveryJob() {
  return cron.schedule("* * * * *", async () => {
    try {
      await webhookService.processDueDeliveries();
    } catch (error) {
      logger.error("Webhook delivery worker failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
