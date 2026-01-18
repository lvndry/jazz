import type { GmailEmail, GmailLabel } from "../../../types/gmail";

/**
 * Gmail tools shared utilities
 */

/**
 * Gmail allowed label colors
 */
export const ALLOWED_LABEL_COLORS = [
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#cccccc",
  "#efefef",
  "#f3f3f3",
  "#ffffff",
  "#fb4c2f",
  "#ffad47",
  "#fad165",
  "#16a766",
  "#43d692",
  "#4a86e8",
  "#a479e2",
  "#f691b3",
  "#f6c5be",
  "#ffe6c7",
  "#fef1d1",
  "#b9e4d0",
  "#c6f3de",
  "#c9daf8",
  "#e4d7f5",
  "#fcdee8",
  "#efa093",
  "#ffd6a2",
  "#fce8b3",
  "#89d3b2",
  "#a0eac9",
  "#a4c2f4",
  "#d0bcf1",
  "#fbc8d9",
  "#e66550",
  "#ffbc6b",
  "#fcda83",
  "#44b984",
  "#68dfa9",
  "#6d9eeb",
  "#b694e8",
  "#f7a7c0",
  "#cc3a21",
  "#eaa041",
  "#f2c960",
  "#149e60",
  "#3dc789",
  "#3c78d8",
  "#8e63ce",
  "#e07798",
  "#ac2b16",
  "#cf8933",
  "#d5ae49",
  "#0b804b",
  "#2a9c68",
  "#285bac",
  "#653e9b",
  "#b65775",
  "#822111",
  "#a46a21",
  "#aa8831",
  "#076239",
  "#1a764d",
  "#1c4587",
  "#41236d",
  "#83334c",
  "#464646",
  "#e7e7e7",
  "#0d3472",
  "#b6cff5",
  "#0d3b44",
  "#98d7e4",
  "#3d188e",
  "#e3d7ff",
  "#711a36",
  "#fbd3e0",
  "#8a1c0a",
  "#f2b2a8",
  "#7a2e0b",
  "#ffc8af",
  "#7a4706",
  "#ffdeb5",
  "#594c05",
  "#fbe983",
  "#684e07",
  "#fdedc1",
  "#0b4f30",
  "#b3efd3",
  "#04502e",
  "#a2dcc1",
  "#c2c2c2",
  "#4986e7",
  "#2da2bb",
  "#b99aff",
  "#994a64",
  "#f691b2",
  "#ff7537",
  "#ffad46",
  "#662e37",
  "#ebdbde",
  "#cca6ac",
  "#094228",
  "#42d692",
  "#16a765",
] as const;

/**
 * Create email preview message for approval dialogs
 */
export function createEmailPreviewMessage(email: GmailEmail): string {
  const now = new Date();
  const emailDate = new Date(email.date);
  const daysInInbox = Math.floor((now.getTime() - emailDate.getTime()) / (1000 * 60 * 60 * 24));

  const isImportant = email.labels?.includes("IMPORTANT") || false;
  const labels =
    email.labels?.filter(
      (label) => !["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH"].includes(label),
    ) || [];

  const labelsText = labels.length > 0 ? `\nLabels: ${labels.join(", ")}` : "";
  const importantText = isImportant ? "\n IMPORTANT" : "";
  const daysText =
    daysInInbox === 0 ? "Today" : daysInInbox === 1 ? "1 day ago" : `${daysInInbox} days ago`;

  return `📧 Email Preview:
Subject: ${email.subject}
From: ${email.from}
Date: ${daysText} (${emailDate.toLocaleDateString()})${importantText}${labelsText}
Snippet: ${email.snippet.substring(0, 100)}${email.snippet.length > 100 ? "..." : ""}`;
}

/**
 * Format emails list for display
 */
export function formatEmailsForDisplay(emails: GmailEmail[]): unknown {
  return emails.map((email) => ({
    id: email.id,
    subject: email.subject,
    from: email.from,
    date: email.date,
    snippet: email.snippet,
    labels: email.labels,
  }));
}

/**
 * Format email detail for display
 */
export function formatEmailDetail(email: GmailEmail): unknown {
  return {
    id: email.id,
    threadId: email.threadId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    date: email.date,
    body: email.body || email.snippet,
    labels: email.labels,
    attachments: email.attachments?.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })),
  };
}

/**
 * Format labels list for display
 */
export function formatLabelsForDisplay(labels: GmailLabel[]): unknown {
  return labels.map((label) => ({
    id: label.id,
    name: label.name,
    type: label.type,
    messagesTotal: label.messagesTotal,
    messagesUnread: label.messagesUnread,
    threadsTotal: label.threadsTotal,
    threadsUnread: label.threadsUnread,
    color: label.color,
    labelListVisibility: label.labelListVisibility,
    messageListVisibility: label.messageListVisibility,
  }));
}

/**
 * Format label detail for display
 */
export function formatLabelForDisplay(label: GmailLabel): unknown {
  return {
    id: label.id,
    name: label.name,
    type: label.type,
    messagesTotal: label.messagesTotal,
    messagesUnread: label.messagesUnread,
    threadsTotal: label.threadsTotal,
    threadsUnread: label.threadsUnread,
    color: label.color,
    labelListVisibility: label.labelListVisibility,
    messageListVisibility: label.messageListVisibility,
  };
}
