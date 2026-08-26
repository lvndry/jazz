import { Context } from "effect";

/**
 * Runtime CLI options passed from the command invocation
 */
export interface CLIOptions {
  /**
   * Enable verbose logging
   */
  readonly verbose?: boolean | undefined;

  /**
   * Enable debug logging
   */
  readonly debug?: boolean | undefined;

  /**
   * Configuration file path
   */
  readonly configPath?: string | undefined;
}

/**
 * Service tag for accessing CLI options in Effect context
 */
export const CLIOptionsTag = Context.GenericTag<CLIOptions>("CLIOptions");
