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

it("does not read inherited object properties as place aliases", () => {
  expect(lookupZoneByPlace("constructor")).toEqual({ kind: "unknown" });
});

it("every picker label names the zone that choosing it saves", () => {
  for (const choice of COMMON_ZONE_CHOICES) {
    const zone = parseTimeZone(choice.zone);
    expect(zone.ok).toBe(true);
    if (zone.ok) {
      expect(lookupZoneByPlace(choice.label)).toEqual({ kind: "found", zone: zone.zone });
    }
  }
});

it("does not silently override a city with a conflicting country or region", () => {
  for (const [place, cityZone] of [
    ["Vancouver, Canada", "America/Vancouver"],
    ["Perth, Australia", "Australia/Perth"],
    ["Paris, Texas", "Europe/Paris"],
  ] as const) {
    const result = lookupZoneByPlace(place);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.zones).toContain(cityZone);
    }
  }
});
