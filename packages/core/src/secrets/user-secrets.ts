/**
 * Secrets held in memory for redaction: values typed for one run and credentials adapters load.
 *
 * The value lives only in this process's memory, in the store of the run that asked for it,
 * and is wiped when that run ends. The model only ever sees `[redacted:<name>]`; the registry
 * puts the value back into the arguments a tool names in `userSecretArguments`, just before
 * that tool runs. A resumed run starts with an empty store, so the model asks again.
 *
 * While a store is open its values are known secrets for redaction everywhere in the process:
 * tool results, logs and anything built from them.
 */

import type { KnownSecret } from "@/core/secrets/redaction";
import { runtimeSecretsForRedaction } from "@/core/secrets/runtime-secrets";
import { PLACEHOLDER_PREFIX, redactionPlaceholder } from "@/core/secrets/secret-names";

/** A short kebab-case label: `pdf-password`, `vpn-token`. */
export const USER_SECRET_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest label a secret can carry, so a placeholder stays one short token. */
export const MAX_USER_SECRET_NAME_LENGTH = 48;

/** One run's typed secrets, by name. */
export class UserSecretStore {
  private readonly values = new Map<string, string>();
  private closed = false;

  /** Hold `value` under `name` for the rest of the run, replacing any earlier value of that name. */
  hold(name: string, value: string): void {
    if (this.closed) {
      return;
    }
    this.values.set(name, value);
  }

  /** The value held under `name`, when this run holds one. */
  valueOf(name: string): string | undefined {
    return this.values.get(name);
  }

  /** Every held value as a known secret, for exact redaction. */
  knownSecrets(): KnownSecret[] {
    return [...this.values.entries()]
      .filter(([, value]) => value.length > 0)
      .map(([name, value]) => ({ name, value }));
  }

  /** Forget every value and stop accepting new ones. */
  close(): void {
    this.values.clear();
    this.closed = true;
  }
}

const openStores = new Set<UserSecretStore>();

/** A new store whose values redact process-wide until `closeUserSecretStore`. */
export function openUserSecretStore(): UserSecretStore {
  const store = new UserSecretStore();
  openStores.add(store);
  return store;
}

/** Wipe `store` and stop redacting against it. */
export function closeUserSecretStore(store: UserSecretStore): void {
  store.close();
  openStores.delete(store);
}

/**
 * Every active typed secret and registered runtime credential in this process, longest first so
 * a value containing another is replaced whole.
 */
export function heldUserSecrets(): KnownSecret[] {
  if (openStores.size === 0 && runtimeSecretsForRedaction().length === 0) {
    return [];
  }
  const byValue = new Map<string, KnownSecret>();
  for (const secret of runtimeSecretsForRedaction()) {
    if (!byValue.has(secret.value)) byValue.set(secret.value, secret);
  }
  for (const store of openStores) {
    for (const secret of store.knownSecrets()) {
      if (!byValue.has(secret.value)) {
        byValue.set(secret.value, secret);
      }
    }
  }
  return [...byValue.values()].sort((left, right) => right.value.length - left.value.length);
}

/** `text` with every held typed secret replaced by its placeholder. */
export function redactHeldUserSecrets(text: string): string {
  let redacted = text;
  for (const secret of heldUserSecrets()) {
    if (redacted.includes(secret.value)) {
      redacted = redacted.split(secret.value).join(redactionPlaceholder(secret.name));
    }
  }
  return redacted;
}

/**
 * `value` with every held typed secret replaced in each string of its arrays and plain objects.
 * Returned as it is when no run holds one.
 */
export function redactHeldUserSecretsDeep<T>(value: T): T {
  if (heldUserSecrets().length === 0) {
    return value;
  }
  const visit = (item: unknown, seen: WeakSet<object>): unknown => {
    if (typeof item === "string") {
      return redactHeldUserSecrets(item);
    }
    if (item === null || typeof item !== "object" || seen.has(item)) {
      return item;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      return item.map((entry: unknown) => visit(entry, seen));
    }
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      return item;
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, nested]) => [key, visit(nested, seen)]),
    );
  };
  return visit(value, new WeakSet()) as T;
}

const PLACEHOLDER_PATTERN = new RegExp(`\\${PLACEHOLDER_PREFIX}([a-z0-9-]+)\\]`, "g");

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, into);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectStrings(nested, into);
    }
  }
}

/** The names of this run's typed secrets whose placeholders appear anywhere in `value`. */
export function userSecretNamesIn(value: unknown, store: UserSecretStore): string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  const names = new Set<string>();
  for (const text of strings) {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      const name = match[1] ?? "";
      if (store.valueOf(name) !== undefined) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Set to a truthy value (by `--dangerously-allow-reading-secrets` or by hand) to let a run load
 * saved secrets and use typed ones without a person approving each use. Meant for unattended
 * runs, which have nobody to ask.
 */
export const ALLOW_READING_SECRETS_ENV_VAR = "JAZZ_DANGEROUSLY_ALLOW_READING_SECRETS";

/** Whether loading or using a secret must go to a person, under every auto-approve policy. */
export function secretUseNeedsPerson(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ALLOW_READING_SECRETS_ENV_VAR]?.trim().toLowerCase();
  return raw === undefined || raw === "" || raw === "0" || raw === "false";
}

/** What a call carrying this run's typed-secret placeholders may do. */
export type UserSecretPlan =
  | { readonly kind: "none" }
  | { readonly kind: "substitute"; readonly names: readonly string[] }
  | {
      readonly kind: "refuse";
      readonly names: readonly string[];
      /** Whether the tool takes typed secrets at all, in other arguments. */
      readonly toolAccepts: boolean;
    };

/** Marks, in an argument path, every element of an array: `actions[].text`. */
const ARRAY_ELEMENT = "[]";

type ArgumentPath = readonly string[];

/**
 * The segments of an argument path as `userSecretArguments` writes it: `text` is a top-level
 * argument, and `actions[].text` is the `text` field of every element of the `actions` array.
 */
function parseArgumentPath(specification: string): ArgumentPath {
  return specification
    .split(".")
    .flatMap((segment) =>
      segment.endsWith(ARRAY_ELEMENT)
        ? [segment.slice(0, -ARRAY_ELEMENT.length), ARRAY_ELEMENT]
        : [segment],
    );
}

function pathsMatch(actual: ArgumentPath, pattern: ArgumentPath): boolean {
  return (
    actual.length === pattern.length && actual.every((segment, index) => segment === pattern[index])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `value` with `transform` applied to each string, given the path it sits at. */
function mapStringLeaves(
  value: unknown,
  path: ArgumentPath,
  transform: (text: string, path: ArgumentPath) => string,
): unknown {
  if (typeof value === "string") {
    return transform(value, path);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => mapStringLeaves(item, [...path, ARRAY_ELEMENT], transform));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        mapStringLeaves(nested, [...path, key], transform),
      ]),
    );
  }
  return value;
}

/**
 * Whether `args` carry any of this run's typed secrets, and whether they sit only in the strings
 * `accepted` names. A name is a top-level argument (`text`) or a field of each element of an
 * array argument (`actions[].text`).
 */
export function planUserSecrets(
  args: Readonly<Record<string, unknown>>,
  accepted: readonly string[],
  store: UserSecretStore,
): UserSecretPlan {
  const names = userSecretNamesIn(args, store);
  if (names.length === 0) {
    return { kind: "none" };
  }
  const patterns = accepted.map(parseArgumentPath);
  const outside: string[] = [];
  mapStringLeaves(args, [], (text, path) => {
    if (!patterns.some((pattern) => pathsMatch(path, pattern))) {
      outside.push(text);
    }
    return text;
  });
  const strayNames = userSecretNamesIn(outside, store);
  if (patterns.length === 0 || strayNames.length > 0) {
    return {
      kind: "refuse",
      names: patterns.length === 0 ? names : strayNames,
      toolAccepts: patterns.length > 0,
    };
  }
  return { kind: "substitute", names };
}

/**
 * The user-secret names whose placeholders sit in the strings `accepted` names but which this
 * run does not hold: a secret typed in an earlier run, or a name the model made up. Config,
 * environment and shape placeholders never match the user-secret name pattern.
 */
export function unheldUserSecretNamesIn(
  args: Readonly<Record<string, unknown>>,
  accepted: readonly string[],
  store: UserSecretStore,
): string[] {
  const patterns = accepted.map(parseArgumentPath);
  const names = new Set<string>();
  mapStringLeaves(args, [], (text, path) => {
    if (patterns.some((pattern) => pathsMatch(path, pattern))) {
      for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
        const name = match[1] ?? "";
        if (
          USER_SECRET_NAME_PATTERN.test(name) &&
          name.length <= MAX_USER_SECRET_NAME_LENGTH &&
          store.valueOf(name) === undefined
        ) {
          names.add(name);
        }
      }
    }
    return text;
  });
  return [...names];
}

/**
 * `args` with every placeholder of this run's typed secrets in the strings `accepted` names
 * (see `planUserSecrets`) replaced by the value. Only names this store holds are replaced: a
 * placeholder for a config secret, an environment variable or a recognised shape has no value
 * here and stays as written.
 */
export function substituteUserSecrets(
  args: Readonly<Record<string, unknown>>,
  accepted: readonly string[],
  store: UserSecretStore,
): Record<string, unknown> {
  const patterns = accepted.map(parseArgumentPath);
  return mapStringLeaves(args, [], (text, path) =>
    patterns.some((pattern) => pathsMatch(path, pattern))
      ? text.replace(PLACEHOLDER_PATTERN, (placeholder, name: string) => {
          return store.valueOf(name) ?? placeholder;
        })
      : text,
  ) as Record<string, unknown>;
}
