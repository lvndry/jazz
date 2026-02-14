/**
 * Represents an email message from Gmail API
 *
 * Complete representation of a Gmail message with all metadata including
 * sender information, recipients, subject, body content, labels, and attachments.
 * This interface mirrors the Gmail API response structure for email messages.
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
 * Gmail label for organizing and categorizing emails
 *
 * Represents a Gmail label which can be applied to messages for organization.
 * Labels can be user-created or system labels (like INBOX, SENT).
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
