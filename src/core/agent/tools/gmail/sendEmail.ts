import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";

/**
 * Send email tool
 */

export function createSendEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      to: z.array(z.string()).min(1).describe("Recipient email addresses"),
      subject: z.string().min(1).describe("Email subject"),
      body: z.string().min(1).describe("Body (plain text)"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
    })
    .strict();

  type SendEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, SendEmailArgs>({
    name: "send_email",
    description: "Compose a Gmail draft for user review. Not sent immediately.",
    tags: ["gmail", "compose"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        const { to, subject, body, cc, bcc } = validatedArgs;
        const options: { cc?: string[]; bcc?: string[] } = {};
        if (cc) options.cc = cc;
        if (bcc) options.bcc = bcc;
        yield* gmailService.sendEmail(to, subject, body, options);
        return { success: true, result: `Draft created for ${to.join(", ")}` };
      }),
  });
}
