import { describe, expect, it } from "bun:test";
import {
  describeCronSchedule,
  isValidCronExpression,
  normalizeCronExpression,
} from "./cron-utils";

describe("cron-utils", () => {
  describe("normalizeCronExpression", () => {
    it("should add seconds field to 5-field cron expressions", () => {
      expect(normalizeCronExpression("0 * * * *")).toBe("0 0 * * * *");
      expect(normalizeCronExpression("0 8 * * *")).toBe("0 0 8 * * *");
      expect(normalizeCronExpression("*/15 * * * *")).toBe("0 */15 * * * *");
    });

    it("should keep 6-field cron expressions unchanged", () => {
      expect(normalizeCronExpression("0 0 * * * *")).toBe("0 0 * * * *");
      expect(normalizeCronExpression("30 0 8 * * *")).toBe("30 0 8 * * *");
    });

    it("should handle expressions with extra whitespace", () => {
      expect(normalizeCronExpression("  0  8  *  *  *  ")).toBe("0 0  8  *  *  *");
      expect(normalizeCronExpression("0\t8\t*\t*\t*")).toBe("0 0\t8\t*\t*\t*");
    });

    it("should return other formats unchanged", () => {
      expect(normalizeCronExpression("* * *")).toBe("* * *");
      expect(normalizeCronExpression("invalid")).toBe("invalid");
    });
  });

  describe("isValidCronExpression", () => {
    it("should accept valid 5-field cron expressions", () => {
      const validCrons = [
        "0 * * * *", // Every hour
        "0 8 * * *", // Daily at 8 AM
        "*/15 * * * *", // Every 15 minutes
        "0 0 * * 0", // Weekly on Sunday
        "0 9 1 * *", // Monthly on the 1st at 9 AM
        "30 4 1,15 * 5", // Complex: 4:30 on 1st and 15th and Fridays
        "0 0 1-7 * 1", // First Monday of month
      ];

      for (const cron of validCrons) {
        expect(isValidCronExpression(cron)).toBe(true);
      }
    });

    it("should accept valid 6-field cron expressions (with seconds)", () => {
      const validCrons = [
        "0 0 * * * *", // Every hour
        "0 0 8 * * *", // Daily at 8 AM
        "0 */15 * * * *", // Every 15 minutes
      ];

      for (const cron of validCrons) {
        expect(isValidCronExpression(cron)).toBe(true);
      }
    });

    it("should reject invalid cron expressions", () => {
      const invalidCrons = [
        "invalid", // Not a cron
        "* * *", // Only 3 fields
        "* * * *", // Only 4 fields
        "60 * * * *", // Invalid minute (60)
        "* 25 * * *", // Invalid hour (25)
        "* * * * * * *", // Too many fields (7)
        "", // Empty string
        "   ", // Only whitespace
      ];

      for (const cron of invalidCrons) {
        expect(isValidCronExpression(cron)).toBe(false);
      }
    });

    it("should handle whitespace correctly", () => {
      expect(isValidCronExpression("  0  8  *  *  *  ")).toBe(true);
      expect(isValidCronExpression("0\t8\t*\t*\t*")).toBe(true);
    });
  });

  describe("describeCronSchedule", () => {
    it("should describe every hour", () => {
      expect(describeCronSchedule("0 * * * *")).toBe("Every hour");
    });

    it("should describe daily at specific time", () => {
      expect(describeCronSchedule("0 8 * * *")).toBe("Daily at 8 AM");
      expect(describeCronSchedule("30 8 * * *")).toBe("Daily at 8:30 AM");
      expect(describeCronSchedule("0 0 * * *")).toBe("Daily at midnight");
      expect(describeCronSchedule("0 12 * * *")).toBe("Daily at 12:00 PM");
    });

    it("should describe weekdays", () => {
      expect(describeCronSchedule("0 9 * * 1-5")).toBe("Weekdays at 9 AM");
    });

    it("should describe specific weekday", () => {
      expect(describeCronSchedule("0 9 * * 1")).toBe("Mondays at 9 AM");
      expect(describeCronSchedule("0 17 * * 5")).toBe("Fridays at 5 PM");
    });

    it("should describe monthly", () => {
      expect(describeCronSchedule("0 0 1 * *")).toBe("Monthly on the 1st at midnight");
      expect(describeCronSchedule("0 9 15 * *")).toBe("Monthly on the 15th at 9 AM");
    });

    it("should return null for invalid or non-5-field expressions", () => {
      expect(describeCronSchedule("")).toBe(null);
      expect(describeCronSchedule("0 8 * *")).toBe(null);
      expect(describeCronSchedule("* * * * * *")).toBe(null);
    });

    it("should describe every N minutes (any N)", () => {
      expect(describeCronSchedule("*/22 * * * *")).toBe("Every 22 minutes");
      expect(describeCronSchedule("*/15 * * * *")).toBe("Every 15 minutes");
      expect(describeCronSchedule("0/15 * * * *")).toBe("Every 15 minutes");
    });

    it("should describe every N minutes on specific day(s)", () => {
      expect(describeCronSchedule("*/15 * * * 5")).toBe("Every 15 minutes on Fridays");
      expect(describeCronSchedule("*/30 * * * 1-5")).toBe("Every 30 minutes on weekdays");
      expect(describeCronSchedule("0/15 * * * 5")).toBe("Every 15 minutes on Fridays");
    });

    it("should describe day-of-week list", () => {
      expect(describeCronSchedule("0 9 * * 1,3,5")).toBe("Mon, Wed, Fri at 9 AM");
      expect(describeCronSchedule("30 14 * * 0,6")).toBe("Sun, Sat at 2:30 PM");
    });

    it("should describe every N hours", () => {
      expect(describeCronSchedule("0 */2 * * *")).toBe("Every 2 hours");
      expect(describeCronSchedule("0 */1 * * *")).toBe("Every hour");
      expect(describeCronSchedule("0 */6 * * *")).toBe("Every 6 hours");
    });
  });
});
