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
      expect(describeCronSchedule("0 8 * * *")).toBe("At 08:00 AM");
      expect(describeCronSchedule("30 8 * * *")).toBe("At 08:30 AM");
      expect(describeCronSchedule("0 0 * * *")).toBe("At 12:00 AM");
      expect(describeCronSchedule("0 12 * * *")).toBe("At 12:00 PM");
    });

    it("should describe weekdays", () => {
      expect(describeCronSchedule("0 9 * * 1-5")).toBe("At 09:00 AM, Monday through Friday");
    });

    it("should describe specific weekday", () => {
      expect(describeCronSchedule("0 9 * * 1")).toBe("At 09:00 AM, only on Monday");
      expect(describeCronSchedule("0 17 * * 5")).toBe("At 05:00 PM, only on Friday");
    });

    it("should describe monthly", () => {
      expect(describeCronSchedule("0 0 1 * *")).toBe("At 12:00 AM, on day 1 of the month");
      expect(describeCronSchedule("0 9 15 * *")).toBe("At 09:00 AM, on day 15 of the month");
    });

    it("should return null for invalid expressions", () => {
      expect(describeCronSchedule("")).toBe(null);
      expect(describeCronSchedule("0 8 * *")).toBe(null);
    });

    it("should handle 6-field (with seconds) expressions", () => {
      expect(describeCronSchedule("* * * * * *")).toBe("Every second");
      expect(describeCronSchedule("30 * * * * *")).toBe("At 30 seconds past the minute");
      expect(describeCronSchedule("0 0 8 * * *")).toBe("At 08:00 AM");
    });

    it("should describe every N minutes (any N)", () => {
      expect(describeCronSchedule("*/22 * * * *")).toBe("Every 22 minutes");
      expect(describeCronSchedule("*/15 * * * *")).toBe("Every 15 minutes");
      expect(describeCronSchedule("0/15 * * * *")).toBe("Every 15 minutes");
    });

    it("should describe every N minutes on specific day(s)", () => {
      expect(describeCronSchedule("*/15 * * * 5")).toBe("Every 15 minutes, only on Friday");
      expect(describeCronSchedule("*/30 * * * 1-5")).toBe("Every 30 minutes, Monday through Friday");
      expect(describeCronSchedule("0/15 * * * 5")).toBe("Every 15 minutes, only on Friday");
    });

    it("should describe day-of-week list", () => {
      expect(describeCronSchedule("0 9 * * 1,3,5")).toBe("At 09:00 AM, only on Monday, Wednesday, and Friday");
      expect(describeCronSchedule("30 14 * * 0,6")).toBe("At 02:30 PM, only on Sunday and Saturday");
    });

    it("should describe every N hours", () => {
      expect(describeCronSchedule("0 */2 * * *")).toBe("On the hour, every 2 hours");
      expect(describeCronSchedule("0 */1 * * *")).toBe("Every hour");
      expect(describeCronSchedule("0 */6 * * *")).toBe("On the hour, every 6 hours");
    });

    it("should describe complex patterns (ranges, specific months)", () => {
      expect(describeCronSchedule("0 8-10 * * *")).toBe("Every hour, between 08:00 AM and 10:00 AM");
      expect(describeCronSchedule("0 0 1 1 *")).toBe("At 12:00 AM, on day 1 of the month, only in January");
      expect(describeCronSchedule("5/15 * * * *")).toBe("Every 15 minutes, starting at 5 minutes past the hour");
    });

    it("should handle special characters like L", () => {
      expect(describeCronSchedule("0 0 L * *")).toBe("At 12:00 AM, on the last day of the month");
    });
  });
});
