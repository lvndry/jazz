/**
 * UI Hooks - centralized exports for all React hooks.
 */

// Input hooks
export {
  useInputService,
  useInputHandler,
  useSubmitHandler,
  useEscapeHandler,
  useTabHandler,
  useTextInput,
  type UseTextInputResult,
  InputPriority,
  InputResults,
} from "./use-input-service";

// Terminal hooks
export {
  useTerminalCapabilities,
  useTerminalService,
  useTerminalType,
  useTerminalSupports,
} from "./use-terminal";
