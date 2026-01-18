import { Context, Effect } from "effect";
import { GmailAuthenticationError, GmailOperationError } from "@/core/types/errors";
import type { GmailEmail, GmailLabel } from "@/core/types/gmail";

export interface GmailService {
  /** Authenticates with Gmail API and initializes the service. */
  readonly authenticate: () => Effect.Effect<void, GmailAuthenticationError>;
  /** Lists emails from the inbox, optionally filtered by query and limited by maxResults. */
  readonly listEmails: (
    maxResults?: number,
    query?: string,
  ) => Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError>;
  /** Retrieves a single email by its ID. */
  readonly getEmail: (
    emailId: string,
  ) => Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError>;
  /** Sends an email with optional CC, BCC, and attachments. */
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
  /** Searches emails using a Gmail query string. */
  readonly searchEmails: (
    query: string,
    maxResults?: number,
  ) => Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError>;

  /** Lists all Gmail labels. */
  readonly listLabels: () => Effect.Effect<
    GmailLabel[],
    GmailOperationError | GmailAuthenticationError
  >;
  /** Creates a new Gmail label with optional visibility and color settings. */
  readonly createLabel: (
    name: string,
    options?: {
      readonly labelListVisibility?: "labelShow" | "labelHide";
      readonly messageListVisibility?: "show" | "hide";
      readonly color?: { readonly textColor: string; readonly backgroundColor: string };
    },
  ) => Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError>;
  /** Updates an existing label's properties. */
  readonly updateLabel: (
    labelId: string,
    updates: {
      readonly name?: string;
      readonly labelListVisibility?: "labelShow" | "labelHide";
      readonly messageListVisibility?: "show" | "hide";
      readonly color?: { readonly textColor: string; readonly backgroundColor: string };
    },
  ) => Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError>;
  /** Deletes a label by ID. */
  readonly deleteLabel: (
    labelId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  /** Adds or removes labels from a single email. */
  readonly modifyEmail: (
    emailId: string,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError>;
  /** Adds or removes labels from multiple emails in a single operation. */
  readonly batchModifyEmails: (
    emailIds: ReadonlyArray<string>,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  /** Moves an email to trash (can be recovered). */
  readonly trashEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
  /** Permanently deletes an email (cannot be recovered). */
  readonly deleteEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
}

/**
 * Gmail service tag for dependency injection
 */
export const GmailServiceTag = Context.GenericTag<GmailService>("GmailService");
