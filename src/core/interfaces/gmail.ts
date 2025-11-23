import { Context, Effect } from "effect";
import { GmailAuthenticationError, GmailOperationError } from "../types/errors";

/**
 * Gmail email interface
 */
export interface GmailEmail {
  readonly id: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string> | undefined;
  readonly bcc?: ReadonlyArray<string> | undefined;
  readonly date: string;
  readonly snippet: string;
  readonly body?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }>;
}

/**
 * Gmail label interface
 */
export interface GmailLabel {
  readonly id: string;
  readonly name: string;
  readonly type: "system" | "user";
  readonly messagesTotal?: number | undefined;
  readonly messagesUnread?: number | undefined;
  readonly threadsTotal?: number | undefined;
  readonly threadsUnread?: number | undefined;
  readonly color?:
    | {
        readonly textColor: string;
        readonly backgroundColor: string;
      }
    | undefined;
  readonly labelListVisibility?: "labelShow" | "labelHide" | undefined;
  readonly messageListVisibility?: "show" | "hide" | undefined;
}

/**
 * Gmail service interface
 * Defines the contract for Gmail operations used by core agent tools
 */
export interface GmailService {
  readonly authenticate: () => Effect.Effect<void, GmailAuthenticationError>;
  readonly listEmails: (
    maxResults?: number,
    query?: string,
  ) => Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError>;
  readonly getEmail: (
    emailId: string,
  ) => Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError>;
  readonly sendEmail: (
    to: ReadonlyArray<string>,
    subject: string,
    body: string,
    options?: {
      readonly cc?: ReadonlyArray<string>;
      readonly bcc?: ReadonlyArray<string>;
      readonly attachments?: ReadonlyArray<{
        readonly filename: string;
        readonly content: string | Buffer;
        readonly contentType?: string;
      }>;
    },
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
  readonly searchEmails: (
    query: string,
    maxResults?: number,
  ) => Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError>;

  // Label management
  readonly listLabels: () => Effect.Effect<
    GmailLabel[],
    GmailOperationError | GmailAuthenticationError
  >;
  readonly createLabel: (
    name: string,
    options?: {
      readonly labelListVisibility?: "labelShow" | "labelHide";
      readonly messageListVisibility?: "show" | "hide";
      readonly color?: { readonly textColor: string; readonly backgroundColor: string };
    },
  ) => Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError>;
  readonly updateLabel: (
    labelId: string,
    updates: {
      readonly name?: string;
      readonly labelListVisibility?: "labelShow" | "labelHide";
      readonly messageListVisibility?: "show" | "hide";
      readonly color?: { readonly textColor: string; readonly backgroundColor: string };
    },
  ) => Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError>;
  readonly deleteLabel: (
    labelId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  // Email modification
  readonly modifyEmail: (
    emailId: string,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError>;
  readonly batchModifyEmails: (
    emailIds: ReadonlyArray<string>,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  // Destructive email operations
  readonly trashEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
  readonly deleteEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
}

/**
 * Gmail service tag for dependency injection
 */
export const GmailServiceTag = Context.GenericTag<GmailService>("GmailService");
