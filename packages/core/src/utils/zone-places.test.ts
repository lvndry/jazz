import { describe, expect, it } from "bun:test";
import { parseTimeZone } from "./user-time-zone";
import { COMMON_ZONE_CHOICES, lookupZoneByPlace } from "./zone-places";

describe("lookupZoneByPlace", () => {
  it("accepts an IANA name unchanged", () => {
    expect(lookupZoneByPlace("europe/paris")).toEqual({ kind: "found", zone: "Europe/Paris" });
  });

  it("resolves a city, ignoring case and accents", () => {
    expect(lookupZoneByPlace("Paris")).toEqual({ kind: "found", zone: "Europe/Paris" });
    expect(lookupZoneByPlace("são paulo")).toEqual({ kind: "found", zone: "America/Sao_Paulo" });
    expect(lookupZoneByPlace("Tokyo")).toEqual({ kind: "found", zone: "Asia/Tokyo" });
  });

  it("resolves multi-word cities and well-known countries", () => {
    expect(lookupZoneByPlace("New York")).toEqual({ kind: "found", zone: "America/New_York" });
    expect(lookupZoneByPlace("India")).toEqual({ kind: "found", zone: "Asia/Kolkata" });
  });

  it("uses the country part of a city, country answer when the city alone is unknown", () => {
    expect(lookupZoneByPlace("Springfield, France")).toEqual({
      kind: "found",
      zone: "Europe/Paris",
    });
  });

  it("reports an unknown place", () => {
    expect(lookupZoneByPlace("Atlantis")).toEqual({ kind: "unknown" });
    expect(lookupZoneByPlace("   ")).toEqual({ kind: "unknown" });
  });

  it("offers only zones the runtime knows", () => {
    for (const choice of COMMON_ZONE_CHOICES) {
      expect(parseTimeZone(choice.zone).ok).toBe(true);
    }
  });
});
