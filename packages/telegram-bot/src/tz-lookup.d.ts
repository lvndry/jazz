// `tz-lookup` ships no type declarations. It exports a single function that
// maps coordinates to an IANA timezone name (e.g. "Europe/Paris").
declare module "tz-lookup" {
  export default function tzlookup(latitude: number, longitude: number): string;
}
