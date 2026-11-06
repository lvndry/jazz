/**
 * Time zones by the places people name them: a short list for a picker, and a lookup from a
 * city or country to the one zone it means, so nobody has to know an IANA name.
 */

import { parseTimeZone } from "./user-time-zone";

export interface ZoneChoice {
  readonly zone: string;
  readonly label: string;
}

/** Zones a picker offers first, west to east, each labelled by the places it covers. */
export const COMMON_ZONE_CHOICES: readonly ZoneChoice[] = [
  { zone: "Pacific/Honolulu", label: "Hawaii" },
  { zone: "America/Anchorage", label: "Alaska" },
  { zone: "America/Los_Angeles", label: "Los Angeles, Vancouver" },
  { zone: "America/Denver", label: "Denver, Calgary" },
  { zone: "America/Chicago", label: "Chicago, Mexico City" },
  { zone: "America/New_York", label: "New York, Toronto" },
  { zone: "America/Sao_Paulo", label: "São Paulo, Buenos Aires" },
  { zone: "UTC", label: "UTC" },
  { zone: "Europe/London", label: "London, Dublin, Lisbon" },
  { zone: "Europe/Paris", label: "Paris, Berlin, Madrid, Rome" },
  { zone: "Europe/Athens", label: "Athens, Helsinki, Kyiv" },
  { zone: "Europe/Istanbul", label: "Istanbul, Moscow" },
  { zone: "Africa/Cairo", label: "Cairo, Johannesburg" },
  { zone: "Africa/Lagos", label: "Lagos, Kinshasa" },
  { zone: "Asia/Dubai", label: "Dubai" },
  { zone: "Asia/Kolkata", label: "India" },
  { zone: "Asia/Bangkok", label: "Bangkok, Jakarta" },
  { zone: "Asia/Shanghai", label: "Beijing, Singapore, Perth" },
  { zone: "Asia/Tokyo", label: "Tokyo, Seoul" },
  { zone: "Australia/Sydney", label: "Sydney, Melbourne" },
  { zone: "Pacific/Auckland", label: "Auckland" },
];

/** Places that are not the last segment of any zone name, or that share a zone with a bigger city. */
const PLACE_ALIASES: Readonly<Record<string, string>> = {
  france: "Europe/Paris",
  germany: "Europe/Berlin",
  spain: "Europe/Madrid",
  italy: "Europe/Rome",
  uk: "Europe/London",
  "united kingdom": "Europe/London",
  england: "Europe/London",
  ireland: "Europe/Dublin",
  portugal: "Europe/Lisbon",
  netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels",
  switzerland: "Europe/Zurich",
  poland: "Europe/Warsaw",
  sweden: "Europe/Stockholm",
  norway: "Europe/Oslo",
  denmark: "Europe/Copenhagen",
  finland: "Europe/Helsinki",
  greece: "Europe/Athens",
  turkey: "Europe/Istanbul",
  russia: "Europe/Moscow",
  india: "Asia/Kolkata",
  bombay: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  japan: "Asia/Tokyo",
  korea: "Asia/Seoul",
  "south korea": "Asia/Seoul",
  china: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  singapore: "Asia/Singapore",
  uae: "Asia/Dubai",
  israel: "Asia/Jerusalem",
  "saudi arabia": "Asia/Riyadh",
  egypt: "Africa/Cairo",
  "south africa": "Africa/Johannesburg",
  nigeria: "Africa/Lagos",
  kenya: "Africa/Nairobi",
  morocco: "Africa/Casablanca",
  australia: "Australia/Sydney",
  "new zealand": "Pacific/Auckland",
  brazil: "America/Sao_Paulo",
  argentina: "America/Argentina/Buenos_Aires",
  "buenos aires": "America/Argentina/Buenos_Aires",
  mexico: "America/Mexico_City",
  canada: "America/Toronto",
  "new york": "America/New_York",
  nyc: "America/New_York",
  boston: "America/New_York",
  miami: "America/New_York",
  washington: "America/New_York",
  atlanta: "America/New_York",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "las vegas": "America/Los_Angeles",
  "san diego": "America/Los_Angeles",
  vancouver: "America/Vancouver",
  texas: "America/Chicago",
  dallas: "America/Chicago",
  houston: "America/Chicago",
  hawaii: "Pacific/Honolulu",
  alaska: "America/Anchorage",
  eastern: "America/New_York",
  pacific: "America/Los_Angeles",
  utc: "UTC",
  gmt: "UTC",
};

export type PlaceZoneLookup =
  | { readonly kind: "found"; readonly zone: string }
  | { readonly kind: "ambiguous"; readonly zones: readonly string[] }
  | { readonly kind: "unknown" };

function normalizePlace(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[_\-.,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let cityIndex: ReadonlyMap<string, readonly string[]> | undefined;

function citiesByName(): ReadonlyMap<string, readonly string[]> {
  if (cityIndex !== undefined) {
    return cityIndex;
  }
  const index = new Map<string, string[]>();
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const segments = zone.split("/");
    const city = normalizePlace(segments[segments.length - 1] ?? "");
    if (city.length > 0) {
      index.set(city, [...(index.get(city) ?? []), zone]);
    }
  }
  cityIndex = index;
  return index;
}

/**
 * The zone a person means by a zone name, a city or a well-known country. Several zones for one
 * name (a country spanning zones is aliased to its capital; a repeated city name is not) report
 * `ambiguous` so the caller asks instead of picking one.
 */
export function lookupZoneByPlace(input: string): PlaceZoneLookup {
  const parsed = parseTimeZone(input);
  if (parsed.ok) {
    return { kind: "found", zone: parsed.zone };
  }
  const parts = input.split(",");
  const candidates = parts.length > 1 ? [input, ...[...parts].reverse()] : [input];
  let ambiguous: readonly string[] | undefined;
  for (const candidate of candidates) {
    const found = lookupPlace(candidate);
    if (found.kind === "found") {
      return found;
    }
    if (found.kind === "ambiguous") {
      ambiguous ??= found.zones;
    }
  }
  return ambiguous === undefined ? { kind: "unknown" } : { kind: "ambiguous", zones: ambiguous };
}

function lookupPlace(input: string): PlaceZoneLookup {
  const place = normalizePlace(input);
  if (place.length === 0) {
    return { kind: "unknown" };
  }
  const alias = PLACE_ALIASES[place];
  if (alias !== undefined) {
    const aliased = parseTimeZone(alias);
    if (aliased.ok) {
      return { kind: "found", zone: aliased.zone };
    }
  }
  const matches = citiesByName().get(place) ?? [];
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    return { kind: "found", zone: only };
  }
  return matches.length > 1 ? { kind: "ambiguous", zones: matches } : { kind: "unknown" };
}
