import { DurableObject } from "cloudflare:workers";

export class PulseTracker extends DurableObject<Env> {
  private alarmCount = 0;

  async track(): Promise<{ message: string; alarmsFired: number }> {
    console.log("[PulseTracker] Starting track method");

    // Set initial alarm for 500ms from now
    await this.ctx.storage.setAlarm(Date.now() + 500);
    await this.ctx.storage.put("tracking", true);
    this.alarmCount = 0;

    console.log("[PulseTracker] Alarm set, waiting 20 seconds...");

    // Wait 20 seconds
    await new Promise((resolve) => setTimeout(resolve, 20000));

    console.log("[PulseTracker] 20 seconds elapsed, cleaning up...");

    // Delete alarm and clear all state
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    const finalCount = this.alarmCount;
    console.log(
      `[PulseTracker] Cleanup complete. Total alarms fired: ${finalCount}`,
    );

    return {
      message: "Tracking complete",
      alarmsFired: finalCount,
    };
  }

  async alarm(): Promise<void> {
    this.alarmCount++;
    const isTracking = await this.ctx.storage.get<boolean>("tracking");

    console.log(
      `[PulseTracker] ALARM #${this.alarmCount} fired at ${new Date().toISOString()} | tracking: ${isTracking}`,
    );

    // If still tracking, schedule next alarm in 500ms
    if (isTracking) {
      await this.ctx.storage.setAlarm(Date.now() + 500);
    }
  }
}
