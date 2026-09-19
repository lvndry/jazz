/** Plugin-scoped secret lookup and deletion over Jazz's existing secret backends. */

import { Effect } from "effect";
import type { PluginSecretDeclaration } from "./manifest-schema";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringBackend,
} from "../secrets/keyring";

export type PluginSecretSource = "environment" | "keyring" | "file" | "missing" | "unavailable";

export interface PluginSecretStatus {
  readonly name: string;
  readonly required: boolean;
  readonly source: PluginSecretSource;
  readonly storageDescription?: string;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function account(pluginId: string, secretName: string): string {
  return `plugin/${encoded(pluginId)}/${encoded(secretName)}`;
}

export class PluginSecretStore {
  private backendPromise: Promise<KeyringBackend> | undefined;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async get(pluginId: string, declaration: PluginSecretDeclaration): Promise<string | undefined> {
    const fromEnvironment = declaration.env ? this.environment[declaration.env]?.trim() : undefined;
    if (fromEnvironment) return fromEnvironment;
    const backend = await this.backend();
    return Effect.runPromise(keyringGet(backend, account(pluginId, declaration.name)));
  }

  async set(pluginId: string, secretName: string, value: string): Promise<boolean> {
    if (value.trim().length === 0) throw new Error("Refusing to store an empty plugin secret");
    const backend = await this.backend();
    return Effect.runPromise(keyringSet(backend, account(pluginId, secretName), value));
  }

  async delete(pluginId: string, secretName: string): Promise<void> {
    const backend = await this.backend();
    await Effect.runPromise(keyringDelete(backend, account(pluginId, secretName)));
  }

  async status(
    pluginId: string,
    declaration: PluginSecretDeclaration,
  ): Promise<PluginSecretStatus> {
    if (declaration.env && this.environment[declaration.env]?.trim()) {
      return { name: declaration.name, required: declaration.required, source: "environment" };
    }
    const backend = await this.backend();
    if (backend === "none") {
      return {
        name: declaration.name,
        required: declaration.required,
        source: "unavailable",
        storageDescription: describeKeyringBackend(backend),
      };
    }
    const value = await Effect.runPromise(keyringGet(backend, account(pluginId, declaration.name)));
    return {
      name: declaration.name,
      required: declaration.required,
      source: value === undefined ? "missing" : backend === "file" ? "file" : "keyring",
      storageDescription: describeKeyringBackend(backend),
    };
  }

  private backend(): Promise<KeyringBackend> {
    this.backendPromise ??= Effect.runPromise(detectKeyringBackend());
    return this.backendPromise;
  }
}
