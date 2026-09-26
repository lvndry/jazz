/**
 * Stand-in command-line tools for eval samples, invoked through per-sample shims
 * (`evals/sandbox.ts`) as `impl.ts <stubRoot> <command> ...args`.
 *
 * Each call is appended to `<stubRoot>/invocations.ndjson`, and tools with state keep it in
 * `<stubRoot>/data/<tool>.json`, so a scenario's oracle can check both what was run and what
 * changed. The mail and calendar stubs implement the subset of Himalaya v2 and khal that the
 * bundled email and calendar skills tell the model to use, with the same output shapes, so
 * following the skill works and improvising around it shows up in the log.
 */
import { readFileSync } from "node:fs";
import { appendStubInvocation, stubState, writeStubState } from "./state";

const [stubRoot = "", command = "", ...args] = process.argv.slice(2);

function log(exitCode: number, note?: string): void {
  appendStubInvocation(stubRoot, {
    at: new Date().toISOString(),
    command,
    args,
    cwd: process.cwd(),
    exitCode,
    ...(note ? { note } : {}),
  });
}

function finish(exitCode: number, stdout = "", stderr = "", note?: string): never {
  if (stdout.length > 0) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (stderr.length > 0) {
    process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  }
  log(exitCode, note);
  process.exit(exitCode);
}

function loadState<State>(tool: string, fallback: State): State {
  return stubState<State>(stubRoot, tool) ?? fallback;
}

function saveState(tool: string, state: unknown): void {
  writeStubState(stubRoot, tool, state);
}

/** Pull `--name value` / `-n value` options out of an argument list; flags without values are `true`. */
function parseOptions(
  list: readonly string[],
  valued: ReadonlySet<string>,
): { options: Map<string, string | true>; positional: string[] } {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const argument = list[index]!;
    if (argument.startsWith("-") && argument.length > 1) {
      if (valued.has(argument) && index + 1 < list.length) {
        options.set(argument, list[index + 1]!);
        index++;
      } else {
        options.set(argument, true);
      }
    } else {
      positional.push(argument);
    }
  }
  return { options, positional };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/* ---------------- himalaya ---------------- */

export interface StubMail {
  id: string;
  from: { name: string; addr: string };
  to: string;
  subject: string;
  date: string;
  flags: string[];
  body: string;
}
export interface MailState {
  accounts: string[];
  mailboxes: Record<string, StubMail[]>;
  outbox: { to: string; subject: string; body: string; sent: boolean; savedTo?: string }[];
  nextId: number;
}

function envelope(mail: StubMail) {
  return {
    id: mail.id,
    flags: mail.flags,
    subject: mail.subject,
    from: mail.from,
    to: { name: null, addr: mail.to },
    date: mail.date,
    has_attachment: false,
  };
}

function matchesQuery(mail: StubMail, query: string): boolean {
  const orParts = query.split(/\s+or\s+/i);
  return orParts.some((orPart) =>
    orPart.split(/\s+and\s+/i).every((condition) => {
      const negated = /^not\s+/i.test(condition.trim());
      const text = condition.trim().replace(/^not\s+/i, "");
      const [field = "", ...rest] = text.split(/\s+/);
      const value = rest.join(" ").toLowerCase();
      let result: boolean;
      switch (field.toLowerCase()) {
        case "from":
          result = `${mail.from.name} ${mail.from.addr}`.toLowerCase().includes(value);
          break;
        case "to":
          result = mail.to.toLowerCase().includes(value);
          break;
        case "subject":
          result = mail.subject.toLowerCase().includes(value);
          break;
        case "body":
          result = mail.body.toLowerCase().includes(value);
          break;
        case "flag":
          result = mail.flags.includes(value);
          break;
        case "date":
          result = mail.date.startsWith(value);
          break;
        case "after":
          result = mail.date.slice(0, 10) > value;
          break;
        case "before":
          result = mail.date.slice(0, 10) < value;
          break;
        default:
          result = `${mail.subject} ${mail.body}`.toLowerCase().includes(text.toLowerCase());
      }
      return negated ? !result : result;
    }),
  );
}

function himalaya(): never {
  const state = loadState<MailState>("mail", {
    accounts: ["personal"],
    mailboxes: { INBOX: [] },
    outbox: [],
    nextId: 1,
  });
  const json = args.includes("--json");
  const rest = args.filter((argument) => argument !== "--json");
  const accountIndex = rest.findIndex((argument) => argument === "-a" || argument === "--account");
  if (accountIndex >= 0) {
    const account = rest[accountIndex + 1];
    if (account === undefined || !state.accounts.includes(account)) {
      finish(1, "", `Error: cannot find account ${account ?? ""}`);
    }
    rest.splice(accountIndex, 2);
  }
  const [group, action, ...tail] = rest;
  if (group === undefined) {
    finish(1, "", "Error: the setup wizard needs a terminal", "bare himalaya");
  }
  if (group === "--version" || group === "-V") {
    finish(0, "himalaya v2.0.0 +imap +smtp");
  }
  if (group === "account" && action === "list") {
    const accounts = state.accounts.map((name, index) => ({
      name,
      backends: "imap, smtp",
      default: index === 0,
    }));
    finish(
      0,
      json
        ? JSON.stringify({ accounts })
        : accounts
            .map(
              (account) =>
                `${account.name}  ${account.backends}${account.default ? "  (default)" : ""}`,
            )
            .join("\n"),
    );
  }
  if (group === "mailbox" && action === "list") {
    const names = Object.keys(state.mailboxes);
    finish(
      0,
      json ? JSON.stringify({ mailboxes: names.map((name) => ({ name })) }) : names.join("\n"),
    );
  }
  if (group === "folder") {
    finish(
      2,
      "",
      "error: unrecognized subcommand 'folder' (renamed to 'mailbox' in v2)",
      "v1 syntax",
    );
  }
  const valued = new Set([
    "-m",
    "--mailbox",
    "-s",
    "--page-size",
    "-p",
    "--page",
    "--to",
    "--from",
    "--subject",
    "--body",
    "--body-file",
    "--save",
    "-f",
    "--flag",
  ]);
  const { options, positional } = parseOptions(tail, valued);
  const mailboxName = String(options.get("-m") ?? options.get("--mailbox") ?? "INBOX");
  const mailbox = (name: string) => {
    const found = state.mailboxes[name];
    if (found === undefined) {
      finish(1, "", `Error: cannot find mailbox ${name}`);
    }
    return found;
  };
  const findMail = (id: string): { box: string; mail: StubMail } => {
    for (const [box, mails] of Object.entries(state.mailboxes)) {
      const mail = mails.find((candidate) => candidate.id === id);
      if (mail !== undefined) {
        return { box, mail };
      }
    }
    return finish(1, "", `Error: cannot find message ${id}`);
  };
  if (group === "envelope" && (action === "list" || action === "search")) {
    if (action === "list" && positional.length > 0) {
      finish(
        2,
        "",
        "error: unexpected argument (envelope list takes no query; use envelope search)",
        "positional query",
      );
    }
    const size = Number(options.get("-s") ?? options.get("--page-size") ?? 10);
    const page = Number(options.get("-p") ?? options.get("--page") ?? 1);
    const query = positional.join(" ");
    const mails = mailbox(mailboxName)
      .filter((mail) => action === "list" || matchesQuery(mail, query))
      .sort((first, second) => second.date.localeCompare(first.date))
      .slice((page - 1) * size, page * size);
    finish(
      0,
      json
        ? JSON.stringify({ envelopes: mails.map(envelope) })
        : mails
            .map(
              (mail) =>
                `${mail.id} | ${mail.flags.join(",")} | ${mail.subject} | ${mail.from.name} <${mail.from.addr}> | ${mail.date}`,
            )
            .join("\n"),
    );
  }
  if (group === "message" && action === "read") {
    const id = positional[0] ?? "";
    const { mail } = findMail(id);
    if (options.has("--seen") && !mail.flags.includes("seen")) {
      mail.flags.push("seen");
      saveState("mail", state);
    }
    finish(
      0,
      json
        ? JSON.stringify({ ...envelope(mail), body: mail.body })
        : `From: ${mail.from.name} <${mail.from.addr}>\nTo: ${mail.to}\nSubject: ${mail.subject}\nDate: ${mail.date}\n\n${mail.body}`,
    );
  }
  if (group === "message" && action === "write") {
    const to = options.get("--to");
    const subject = options.get("--subject");
    const bodyFile = options.get("--body-file");
    const body =
      typeof options.get("--body") === "string"
        ? String(options.get("--body"))
        : typeof bodyFile === "string"
          ? readFileSync(bodyFile, "utf8")
          : readStdin();
    if (typeof to !== "string" || typeof subject !== "string") {
      finish(1, "", "Error: --to and --subject are required without an editor");
    }
    const sent = options.has("--send");
    const save = options.get("--save");
    state.outbox.push({
      to,
      subject,
      body,
      sent,
      ...(typeof save === "string" ? { savedTo: save } : {}),
    });
    if (!sent) {
      const drafts = state.mailboxes["Drafts"] ?? [];
      drafts.push({
        id: String(state.nextId++),
        from: { name: "Me", addr: "me@ourco.com" },
        to,
        subject,
        date: new Date().toISOString(),
        flags: ["draft"],
        body,
      });
      state.mailboxes["Drafts"] = drafts;
    }
    saveState("mail", state);
    finish(0, sent ? "Message successfully sent!" : "Message saved to Drafts.");
  }
  if (group === "message" && (action === "reply" || action === "forward")) {
    if (!options.has("--body")) {
      finish(1, "", "Error: cannot open an editor without a terminal");
    }
    const { mail } = findMail(positional[0] ?? "");
    const to = action === "reply" ? mail.from.addr : String(options.get("--to") ?? "");
    state.outbox.push({
      to,
      subject: `Re: ${mail.subject}`,
      body: String(options.get("--body")),
      sent: options.has("--send"),
    });
    saveState("mail", state);
    finish(0, options.has("--send") ? "Message successfully sent!" : "Message saved to Drafts.");
  }
  if (group === "message" && (action === "move" || action === "copy")) {
    const target = options.get("--to");
    if (typeof target !== "string") {
      finish(1, "", "Error: --to <MAILBOX> is required");
    }
    const destination = mailbox(target);
    for (const id of positional) {
      const { box, mail } = findMail(id);
      if (action === "move") {
        state.mailboxes[box] = mailbox(box).filter((candidate) => candidate.id !== id);
        destination.push(mail);
      } else {
        destination.push({ ...mail, id: String(state.nextId++) });
      }
    }
    saveState("mail", state);
    finish(0, `Message(s) successfully ${action === "move" ? "moved" : "copied"} to ${target}!`);
  }
  if (group === "message" && action === "delete") {
    const trash = (state.mailboxes["Trash"] ??= []);
    for (const id of positional) {
      const { box, mail } = findMail(id);
      state.mailboxes[box] = mailbox(box).filter((candidate) => candidate.id !== id);
      if (box !== "Trash") {
        trash.push(mail);
      }
    }
    saveState("mail", state);
    finish(0, "Message(s) successfully deleted!");
  }
  if (group === "flag" && (action === "add" || action === "remove")) {
    const flag = options.get("-f") ?? options.get("--flag");
    if (typeof flag !== "string") {
      finish(2, "", "error: the following required arguments were not provided: --flag <FLAG>");
    }
    for (const id of positional) {
      const { mail } = findMail(id);
      mail.flags =
        action === "add"
          ? [...new Set([...mail.flags, flag])]
          : mail.flags.filter((existing) => existing !== flag);
    }
    saveState("mail", state);
    finish(0, `Flag(s) successfully ${action === "add" ? "added" : "removed"}!`);
  }
  finish(
    2,
    "",
    `error: unrecognized subcommand '${[group, action].filter(Boolean).join(" ")}'`,
    "unsupported",
  );
}

/* ---------------- khal / vdirsyncer ---------------- */

export interface StubEvent {
  uid: string;
  calendar: string;
  start: string;
  end: string;
  title: string;
  location?: string;
}
export interface CalendarState {
  calendars: string[];
  events: StubEvent[];
  nextUid: number;
  synced: boolean;
}

function addMinutes(dateTime: string, minutesToAdd: number): string {
  const date = new Date(`${dateTime.replace(" ", "T")}:00Z`);
  date.setUTCMinutes(date.getUTCMinutes() + minutesToAdd);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function durationMinutes(text: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/.exec(text);
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    return undefined;
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function khal(): never {
  const state = loadState<CalendarState>("calendar", {
    calendars: ["personal"],
    events: [],
    nextUid: 1,
    synced: false,
  });
  const [action, ...tail] = args;
  const { options, positional } = parseOptions(
    tail,
    new Set(["-a", "--format", "--location", "-l"]),
  );
  const format =
    typeof options.get("--format") === "string"
      ? String(options.get("--format"))
      : "{start-time}-{end-time} {title}";
  const render = (event: StubEvent) =>
    format
      .replaceAll("{start}", event.start)
      .replaceAll("{end}", event.end)
      .replaceAll("{start-time}", event.start.slice(11))
      .replaceAll("{end-time}", event.end.slice(11))
      .replaceAll("{title}", event.title)
      .replaceAll("{uid}", event.uid)
      .replaceAll("{calendar}", event.calendar);
  const calendarFilter = options.get("-a");
  const inCalendar = (event: StubEvent) =>
    typeof calendarFilter !== "string" || event.calendar === calendarFilter;
  if (action === "printcalendars") {
    finish(0, state.calendars.join("\n"));
  }
  if (action === "list") {
    const dates = positional.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (dates.length === 0) {
      finish(
        1,
        "",
        "Error: give explicit dates (YYYY-MM-DD [YYYY-MM-DD]) in this environment",
        "relative range",
      );
    }
    const from = dates[0]!;
    const to = dates[1] ?? from;
    const events = state.events
      .filter(
        (event) =>
          inCalendar(event) && event.start.slice(0, 10) >= from && event.start.slice(0, 10) <= to,
      )
      .sort((first, second) => first.start.localeCompare(second.start));
    const lines: string[] = [];
    let currentDay = "";
    for (const event of events) {
      if (event.start.slice(0, 10) !== currentDay) {
        currentDay = event.start.slice(0, 10);
        lines.push(currentDay);
      }
      lines.push(render(event));
    }
    finish(0, lines.length > 0 ? lines.join("\n") : "No events");
  }
  if (action === "new") {
    const [date, time, lengthOrEnd, ...titleWords] = positional;
    const calendar = typeof calendarFilter === "string" ? calendarFilter : state.calendars[0]!;
    if (
      date === undefined ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      time === undefined ||
      !/^\d{2}:\d{2}$/.test(time) ||
      lengthOrEnd === undefined ||
      titleWords.length === 0
    ) {
      finish(
        1,
        "",
        'Error: use the structured form: khal new [-a CAL] YYYY-MM-DD HH:MM <1h|30m|HH:MM> "Title"',
        "unparsed new",
      );
    }
    if (!state.calendars.includes(calendar)) {
      finish(1, "", `Error: unknown calendar ${calendar}`);
    }
    const start = `${date} ${time}`;
    const minutes = durationMinutes(lengthOrEnd);
    const end =
      minutes !== undefined
        ? addMinutes(start, minutes)
        : /^\d{2}:\d{2}$/.test(lengthOrEnd)
          ? `${date} ${lengthOrEnd}`
          : undefined;
    if (end === undefined) {
      finish(1, "", `Error: cannot parse ${lengthOrEnd} as a duration or end time`);
    }
    const event: StubEvent = {
      uid: `evt-${state.nextUid++}`,
      calendar,
      start,
      end,
      title: titleWords.join(" "),
      ...(typeof options.get("--location") === "string"
        ? { location: String(options.get("--location")) }
        : {}),
    };
    state.events.push(event);
    saveState("calendar", state);
    finish(0, `Event created: ${event.uid}`);
  }
  if (action === "search") {
    const term = positional.join(" ").toLowerCase();
    const found = state.events.filter(
      (event) => inCalendar(event) && event.title.toLowerCase().includes(term),
    );
    finish(
      0,
      found
        .map((event) => `${event.uid}  ${event.start}  ${event.title}  [${event.calendar}]`)
        .join("\n") || "No events",
    );
  }
  if (action === "delete") {
    const uid = positional[0];
    const before = state.events.length;
    state.events = state.events.filter((event) => event.uid !== uid);
    saveState("calendar", state);
    finish(
      before === state.events.length ? 1 : 0,
      before === state.events.length ? "" : `Deleted ${uid}`,
      before === state.events.length ? `Error: no event ${uid}` : "",
    );
  }
  if (action === "edit" || action === "interactive" || action === "ikhal") {
    finish(1, "", "Error: this command needs a terminal; delete and re-create the event instead");
  }
  finish(2, "", `Error: unknown command ${action ?? ""}`, "unsupported");
}

function vdirsyncer(): never {
  if (args[0] === "sync" || args[0] === "discover") {
    const state = loadState<CalendarState>("calendar", {
      calendars: ["personal"],
      events: [],
      nextUid: 1,
      synced: false,
    });
    state.synced = true;
    saveState("calendar", state);
    finish(0, "Syncing calendars/personal\nSyncing calendars/work");
  }
  finish(2, "", `Error: unknown command ${args[0] ?? ""}`);
}

/* ---------------- OS scheduling, packages, network ---------------- */

function crontab(): never {
  const state = loadState<{ entries: string }>("crontab", { entries: "" });
  if (args[0] === "-l") {
    finish(
      state.entries.length > 0 ? 0 : 1,
      state.entries,
      state.entries.length > 0 ? "" : "crontab: no crontab for user",
    );
  }
  if (args[0] === "-r") {
    saveState("crontab", { entries: "" });
    finish(0);
  }
  if (args[0] === "-e") {
    finish(1, "", "crontab: editing needs a terminal");
  }
  const source =
    args[0] === "-" || args[0] === undefined ? readStdin() : readFileSync(args[0], "utf8");
  saveState("crontab", { entries: source });
  finish(0);
}

switch (command) {
  case "himalaya":
    himalaya();
    break;
  case "khal":
    khal();
    break;
  case "vdirsyncer":
    vdirsyncer();
    break;
  case "crontab":
    crontab();
    break;
  case "launchctl":
  case "at":
    finish(0, "", "", "os scheduling attempted");
    break;
  case "osascript":
  case "notify-send":
    finish(0, "", "", "desktop notification");
    break;
  case "brew":
    finish(
      1,
      "",
      "Error: package installs are disabled in this environment",
      "package install attempted",
    );
    break;
  case "curl":
  case "wget":
    finish(
      6,
      "",
      `${command}: (6) Could not resolve host: network is disabled in this environment`,
      "network attempted",
    );
    break;
  default:
    finish(127, "", `${command}: command not found`);
}
