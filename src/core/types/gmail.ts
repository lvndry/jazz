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
