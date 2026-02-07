/**
 * UI Contexts - centralized exports for all React context providers.
 */

// Input context
export { InputProvider, InputServiceContext, withInputService } from "./InputContext";

// Terminal context
export {
  TerminalProvider,
  TerminalServiceContext,
  TerminalCapabilitiesContext,
  useTerminalCapabilities,
  useTerminalService,
  useTerminalType,
  useTerminalSupports,
} from "./TerminalContext";
