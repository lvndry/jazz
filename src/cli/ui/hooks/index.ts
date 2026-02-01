/**
 * UI Hooks - centralized exports for all React hooks.
 */

// App State hooks
export {
  useAppStateService,
  useLogs,
  usePrompt,
  useStatus,
  useStream,
  useWorkingDirectory,
  useCustomView,
  useLogActions,
  usePromptActions,
  useStatusActions,
  useStreamActions,
  useAppStateActions,
} from "./use-app-state";

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
