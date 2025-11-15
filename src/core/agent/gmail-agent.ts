import { Effect } from "effect";
import { GmailServiceTag, type GmailEmail, type GmailService } from "../../services/gmail";
import type { Task, TaskResult } from "../types/index";

/**
 * Gmail agent service for executing Gmail tasks
 */

export class GmailTaskError extends Error {
  readonly _tag = "GmailTaskError";
  constructor(
    public readonly taskId: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "GmailTaskError";
  }
}

/**
 * Execute a Gmail task
 */
export function executeGmailTask(
  task: Task,
): Effect.Effect<TaskResult, GmailTaskError, GmailService> {
  return Effect.gen(function* () {
    const startTime = Date.now();

    try {
      // Get Gmail service
      const gmailService = yield* GmailServiceTag;

      // Execute the task based on the Gmail operation
      switch (task.config.gmailOperation) {
        case "list_emails": {
          const maxResults = (task.config.gmailMaxResults as number) || 10;
          const query = (task.config.gmailQuery as string) || "";

          const emails = yield* gmailService.listEmails(maxResults, query).pipe(
            Effect.catchAll((error) => {
              if (error._tag === "GmailAuthenticationError") {
                return Effect.fail(
                  new GmailTaskError(task.id, `Authentication error: ${error.message}`, error),
                );
              } else {
                return Effect.fail(
                  new GmailTaskError(task.id, `Operation error: ${error.message}`, error),
                );
              }
            }),
          );

          // Format the result
          const formattedEmails = emails.map(formatEmailSummary);

          return {
            taskId: task.id,
            status: "success",
            output: JSON.stringify(formattedEmails, null, 2),
            duration: Date.now() - startTime,
            timestamp: new Date(),
            metadata: {
              emailCount: emails.length,
              query: query || "inbox",
            },
          };
        }

        case "get_email": {
          const emailId = task.config.emailId as string;

          if (!emailId) {
            return {
              taskId: task.id,
              status: "failure",
              error: "Email ID is required for get_email operation",
              duration: Date.now() - startTime,
              timestamp: new Date(),
            };
          }

          const email = yield* gmailService.getEmail(emailId).pipe(
            Effect.catchAll((error) => {
              if (error._tag === "GmailAuthenticationError") {
                return Effect.fail(
                  new GmailTaskError(task.id, `Authentication error: ${error.message}`),
                );
              } else {
                return Effect.fail(
                  new GmailTaskError(task.id, `Operation error: ${error.message}`),
                );
              }
            }),
          );

          return {
            taskId: task.id,
            status: "success",
            output: JSON.stringify(email, null, 2),
            duration: Date.now() - startTime,
            timestamp: new Date(),
            metadata: {
              emailId: email.id,
              subject: email.subject,
            },
          };
        }

        case "send_email": {
          const to = (task.config.to as string[]) || [];
          const subject = (task.config.subject as string) || "";
          const body = (task.config.body as string) || "";
          const cc = (task.config.cc as string[]) || undefined;
          const bcc = (task.config.bcc as string[]) || undefined;

          if (to.length === 0 || !subject || !body) {
            return {
              taskId: task.id,
              status: "failure",
              error: "Recipients, subject, and body are required for send_email operation",
              duration: Date.now() - startTime,
              timestamp: new Date(),
            };
          }

          yield* gmailService.sendEmail(to, subject, body, { cc, bcc }).pipe(
            Effect.catchAll((error) => {
              if (error._tag === "GmailAuthenticationError") {
                return Effect.fail(
                  new GmailTaskError(task.id, `Authentication error: ${error.message}`),
                );
              } else {
                return Effect.fail(
                  new GmailTaskError(task.id, `Operation error: ${error.message}`),
                );
              }
            }),
          );

          return {
            taskId: task.id,
            status: "success",
            output: `Draft created for ${to.join(", ")}`,
            duration: Date.now() - startTime,
            timestamp: new Date(),
            metadata: {
              recipients: to.length,
              subject,
            },
          };
        }

        case "search_emails": {
          const query = (task.config.gmailQuery as string) || "";
          const maxResults = (task.config.gmailMaxResults as number) || 10;

          if (!query) {
            return {
              taskId: task.id,
              status: "failure",
              error: "Search query is required for search_emails operation",
              duration: Date.now() - startTime,
              timestamp: new Date(),
            };
          }

          const emails = yield* gmailService.searchEmails(query, maxResults).pipe(
            Effect.catchAll((error) => {
              if (error._tag === "GmailAuthenticationError") {
                return Effect.fail(
                  new GmailTaskError(task.id, `Authentication error: ${error.message}`),
                );
              } else {
                return Effect.fail(
                  new GmailTaskError(task.id, `Operation error: ${error.message}`),
                );
              }
            }),
          );

          // Format the result
          const formattedEmails = emails.map(formatEmailSummary);

          return {
            taskId: task.id,
            status: "success",
            output: JSON.stringify(formattedEmails, null, 2),
            duration: Date.now() - startTime,
            timestamp: new Date(),
            metadata: {
              emailCount: emails.length,
              query,
            },
          };
        }

        default:
          return {
            taskId: task.id,
            status: "failure",
            error: `Unknown Gmail operation: ${task.config.gmailOperation}`,
            duration: Date.now() - startTime,
            timestamp: new Date(),
          };
      }
    } catch (error) {
      return {
        taskId: task.id,
        status: "failure",
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
    }
  });
}

/**
 * Format an email for display
 */
function formatEmailSummary(email: GmailEmail): Record<string, unknown> {
  return {
    id: email.id,
    subject: email.subject,
    from: email.from,
    date: email.date,
    snippet: email.snippet,
  };
}
