/**
 * Which network addresses a model-directed request may reach.
 *
 * A tool that fetches a URL the model chose (`http_request`, `web_fetch`, `read_pdf`, the
 * headless renderers) can be pointed at this machine, the LAN, or a cloud metadata service by
 * anything the model read. This module answers one question for such a tool: is this address on
 * the public internet, and if not, has the agent's operator listed it in
 * `network.allowPrivateHosts`?
 *
 * - `classifyAddress` names the special-purpose range an IP literal falls in, or `"public"`. The
 *   ranges come from the IANA IPv4 and IPv6 Special-Purpose Address Registries (RFC 6890): every
 *   block marked not globally reachable, plus multicast and the transition forms that embed an
 *   IPv4 address (IPv4-mapped, IPv4-compatible, NAT64, 6to4), which are judged by the embedded
 *   address or refused outright.
 * - `parsePrivateHostAllowlist` turns the configured entries (hostnames, `*.suffix` wildcards,
 *   IP literals, CIDR blocks) into a matcher; `describePrivateHostEntryError` validates one entry
 *   at the config boundary.
 *
 * Callers pass addresses exactly as the WHATWG URL parser or the resolver produced them. The URL
 * parser already rewrites the unusual IPv4 spellings (`2130706433`, `0x7f000001`, `0177.0.0.1`,
 * `127.1`) to dotted decimal, so a check on `new URL(input).hostname` sees the address the socket
 * will connect to.
 */

import { isIPv4, isIPv6 } from "node:net";

/** The range an address falls in; everything except `"public"` is refused by default. */
export type AddressClass =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "link-local"
  | "shared-address-space"
  | "ipv4-mapped"
  | "multicast"
  | "reserved";

interface AddressBlock {
  readonly base: bigint;
  readonly prefixLength: number;
  readonly addressClass: Exclude<AddressClass, "public">;
}

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_OCTETS = 4;
const IPV6_GROUPS = 8;
const BITS_PER_OCTET = 8;
const BITS_PER_GROUP = 16;
const MAX_OCTET = 255;
const MAX_GROUP = 0xffff;

function ipv4ToBigInt(address: string): bigint | undefined {
  const parts = address.split(".");
  if (parts.length !== IPV4_OCTETS) {
    return undefined;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > MAX_OCTET) {
      return undefined;
    }
    value = (value << BigInt(BITS_PER_OCTET)) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(rawAddress: string): bigint | undefined {
  const zoneIndex = rawAddress.indexOf("%");
  const address = zoneIndex === -1 ? rawAddress : rawAddress.slice(0, zoneIndex);
  if (!isIPv6(address)) {
    return undefined;
  }

  let groups: string[];
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  let embeddedIpv4: bigint | undefined;
  let head = address;
  if (tail.includes(".")) {
    embeddedIpv4 = ipv4ToBigInt(tail);
    if (embeddedIpv4 === undefined) {
      return undefined;
    }
    head = `${address.slice(0, lastColon + 1)}0:0`;
  }

  const doubleColon = head.indexOf("::");
  if (doubleColon === -1) {
    groups = head.split(":");
  } else {
    const left = head.slice(0, doubleColon);
    const right = head.slice(doubleColon + 2);
    const leftGroups = left.length > 0 ? left.split(":") : [];
    const rightGroups = right.length > 0 ? right.split(":") : [];
    const missing = IPV6_GROUPS - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array.from({ length: missing }, () => "0"), ...rightGroups];
  }
  if (groups.length !== IPV6_GROUPS) {
    return undefined;
  }

  let value = 0n;
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    if (Number.isNaN(parsed) || parsed > MAX_GROUP) {
      return undefined;
    }
    value = (value << BigInt(BITS_PER_GROUP)) | BigInt(parsed);
  }
  if (embeddedIpv4 !== undefined) {
    value = (value & ~((1n << BigInt(IPV4_BITS)) - 1n)) | embeddedIpv4;
  }
  return value;
}

function block(
  cidr: string,
  addressClass: AddressBlock["addressClass"],
  parse: (address: string) => bigint | undefined,
): AddressBlock {
  const [address = "", prefix = ""] = cidr.split("/");
  const base = parse(address);
  if (base === undefined) {
    throw new Error(`Invalid built-in address block ${cidr}`);
  }
  return { base, prefixLength: Number(prefix), addressClass };
}

const IPV4_BLOCKS: readonly AddressBlock[] = [
  block("0.0.0.0/8", "unspecified", ipv4ToBigInt),
  block("10.0.0.0/8", "private", ipv4ToBigInt),
  block("100.64.0.0/10", "shared-address-space", ipv4ToBigInt),
  block("127.0.0.0/8", "loopback", ipv4ToBigInt),
  block("169.254.0.0/16", "link-local", ipv4ToBigInt),
  block("172.16.0.0/12", "private", ipv4ToBigInt),
  block("192.0.0.0/24", "reserved", ipv4ToBigInt),
  block("192.0.2.0/24", "reserved", ipv4ToBigInt),
  block("192.88.99.0/24", "reserved", ipv4ToBigInt),
  block("192.168.0.0/16", "private", ipv4ToBigInt),
  block("198.18.0.0/15", "reserved", ipv4ToBigInt),
  block("198.51.100.0/24", "reserved", ipv4ToBigInt),
  block("203.0.113.0/24", "reserved", ipv4ToBigInt),
  block("224.0.0.0/4", "multicast", ipv4ToBigInt),
  block("240.0.0.0/4", "reserved", ipv4ToBigInt),
];

const IPV6_BLOCKS: readonly AddressBlock[] = [
  block("::/128", "unspecified", ipv6ToBigInt),
  block("::1/128", "loopback", ipv6ToBigInt),
  block("::ffff:0:0/96", "ipv4-mapped", ipv6ToBigInt),
  block("::/96", "reserved", ipv6ToBigInt),
  block("64:ff9b:1::/48", "private", ipv6ToBigInt),
  block("100::/64", "reserved", ipv6ToBigInt),
  block("2001::/23", "reserved", ipv6ToBigInt),
  block("2001:db8::/32", "reserved", ipv6ToBigInt),
  block("3fff::/20", "reserved", ipv6ToBigInt),
  block("5f00::/16", "reserved", ipv6ToBigInt),
  block("fc00::/7", "private", ipv6ToBigInt),
  block("fe80::/10", "link-local", ipv6ToBigInt),
  block("fec0::/10", "private", ipv6ToBigInt),
  block("ff00::/8", "multicast", ipv6ToBigInt),
];

/** NAT64 (RFC 6052) and 6to4 (RFC 3056) carry an IPv4 address that decides where packets land. */
const NAT64_PREFIX = block("64:ff9b::/96", "reserved", ipv6ToBigInt);
const SIX_TO_FOUR_PREFIX = block("2002::/16", "reserved", ipv6ToBigInt);
const SIX_TO_FOUR_IPV4_SHIFT = 80n;

function inBlock(value: bigint, totalBits: number, candidate: AddressBlock): boolean {
  const hostBits = BigInt(totalBits - candidate.prefixLength);
  return value >> hostBits === candidate.base >> hostBits;
}

function classifyIpv4Value(value: bigint): AddressClass {
  for (const candidate of IPV4_BLOCKS) {
    if (inBlock(value, IPV4_BITS, candidate)) {
      return candidate.addressClass;
    }
  }
  return "public";
}

function classifyIpv6Value(value: bigint): AddressClass {
  const ipv4Mask = (1n << BigInt(IPV4_BITS)) - 1n;
  if (inBlock(value, IPV6_BITS, NAT64_PREFIX)) {
    return classifyIpv4Value(value & ipv4Mask);
  }
  if (inBlock(value, IPV6_BITS, SIX_TO_FOUR_PREFIX)) {
    return classifyIpv4Value((value >> SIX_TO_FOUR_IPV4_SHIFT) & ipv4Mask);
  }
  for (const candidate of IPV6_BLOCKS) {
    if (inBlock(value, IPV6_BITS, candidate)) {
      return candidate.addressClass;
    }
  }
  return "public";
}

/** Strip the brackets the URL parser keeps around an IPv6 hostname. */
export function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** True when `host` (bracketed or not) is an IPv4 or IPv6 literal rather than a name. */
export function isIpLiteral(host: string): boolean {
  const bare = unbracketHost(host);
  return isIPv4(bare) || ipv6ToBigInt(bare) !== undefined;
}

/**
 * The special-purpose range `address` belongs to, or `"public"`.
 *
 * Anything that does not parse as an IP address is `"reserved"`, so a caller that feeds this a
 * hostname by mistake refuses rather than connects.
 */
export function classifyAddress(address: string): AddressClass {
  const bare = unbracketHost(address);
  if (isIPv4(bare)) {
    const value = ipv4ToBigInt(bare);
    return value === undefined ? "reserved" : classifyIpv4Value(value);
  }
  const value = ipv6ToBigInt(bare);
  return value === undefined ? "reserved" : classifyIpv6Value(value);
}

type AllowlistEntry =
  | { readonly kind: "host"; readonly hostname: string }
  | { readonly kind: "suffix"; readonly suffix: string }
  | { readonly kind: "block"; readonly family: 4 | 6; readonly block: AddressBlock };

/** Matches configured `network.allowPrivateHosts` entries against hostnames and addresses. */
export interface PrivateHostAllowlist {
  /** No entries at all: every non-public address is refused. */
  readonly isEmpty: boolean;
  /** The operator listed this hostname (exactly, or through a `*.suffix` wildcard). */
  readonly allowsHostname: (hostname: string) => boolean;
  /** The operator listed this address, as a literal or inside a CIDR block. */
  readonly allowsAddress: (address: string) => boolean;
}

/** Lowercase and drop the trailing root dot, so `LOCALHOST.` and `localhost` compare equal. */
export function normalizeHostname(hostname: string): string {
  const lower = unbracketHost(hostname).toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

function parseEntry(rawEntry: string): AllowlistEntry | string {
  const entry = rawEntry.trim();
  if (entry.length === 0) {
    return "entries cannot be empty";
  }

  const slash = entry.indexOf("/");
  const addressPart = unbracketHost(slash === -1 ? entry : entry.slice(0, slash));
  const prefixPart = slash === -1 ? undefined : entry.slice(slash + 1);

  const ipv4Value = isIPv4(addressPart) ? ipv4ToBigInt(addressPart) : undefined;
  const ipv6Value = ipv4Value === undefined ? ipv6ToBigInt(addressPart) : undefined;
  if (ipv4Value !== undefined || ipv6Value !== undefined) {
    const family = ipv4Value !== undefined ? 4 : 6;
    const totalBits = family === 4 ? IPV4_BITS : IPV6_BITS;
    const prefixLength = prefixPart === undefined ? totalBits : Number(prefixPart);
    if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > totalBits) {
      return `"${entry}" has an invalid prefix length (use 0-${String(totalBits)})`;
    }
    return {
      kind: "block",
      family,
      block: { base: ipv4Value ?? ipv6Value ?? 0n, prefixLength, addressClass: "private" },
    };
  }

  if (prefixPart !== undefined) {
    return `"${entry}" is not a valid CIDR block`;
  }

  if (entry.startsWith("*.")) {
    const suffix = normalizeHostname(entry.slice(2));
    if (!HOSTNAME_PATTERN.test(suffix)) {
      return `"${entry}" is not a valid wildcard; use *.example.lan`;
    }
    return { kind: "suffix", suffix };
  }

  const hostname = normalizeHostname(entry);
  if (!HOSTNAME_PATTERN.test(hostname)) {
    return `"${entry}" is not a hostname, IP address or CIDR block`;
  }
  return { kind: "host", hostname };
}

/** Why one `network.allowPrivateHosts` entry is invalid, or undefined when it is valid. */
export function describePrivateHostEntryError(entry: string): string | undefined {
  const parsed = parseEntry(entry);
  return typeof parsed === "string" ? parsed : undefined;
}

/**
 * Build the matcher for an agent's `network.allowPrivateHosts`.
 *
 * Invalid entries are skipped here because the agent config boundary already rejected them;
 * a hand-edited file that slipped past it narrows access rather than widening it.
 */
export function parsePrivateHostAllowlist(
  entries: readonly string[] | undefined,
): PrivateHostAllowlist {
  const parsed = (entries ?? [])
    .map(parseEntry)
    .filter((entry): entry is AllowlistEntry => typeof entry !== "string");

  return {
    isEmpty: parsed.length === 0,
    allowsHostname: (hostname) => {
      const normalized = normalizeHostname(hostname);
      return parsed.some(
        (entry) =>
          (entry.kind === "host" && entry.hostname === normalized) ||
          (entry.kind === "suffix" && normalized.endsWith(`.${entry.suffix}`)),
      );
    },
    allowsAddress: (address) => {
      const bare = unbracketHost(address);
      const ipv4Value = isIPv4(bare) ? ipv4ToBigInt(bare) : undefined;
      const ipv6Value = ipv4Value === undefined ? ipv6ToBigInt(bare) : undefined;
      return parsed.some((entry) => {
        if (entry.kind !== "block") {
          return false;
        }
        if (entry.family === 4 && ipv4Value !== undefined) {
          return inBlock(ipv4Value, IPV4_BITS, entry.block);
        }
        if (entry.family === 6 && ipv6Value !== undefined) {
          return inBlock(ipv6Value, IPV6_BITS, entry.block);
        }
        return false;
      });
    },
  };
}
