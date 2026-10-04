/**
 * Publish complete Cloudflare Pages snapshots through the asset API.
 * `prepareCloudflarePublish` resolves the assigned project hostname and installs
 * email-only Access gates for private canonical, immutable and custom URLs before
 * a caller pushes source or uploads assets. `deployToCloudflare` then uploads the
 * snapshot and requires a successful deployment response. Fetch and asset reads
 * are injected so the protocol and its failure boundaries can be tested offline.
 */
import { extname } from "node:path";
import { blake3 } from "@noble/hashes/blake3.js";
import { z } from "zod";

const CF_BASE = "https://api.cloudflare.com/client/v4";
const MAX_ASSETS = 20_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const hostnameSchema = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i);
const projectSchema = z.object({
  subdomain: hostnameSchema.refine((host) => host.endsWith(".pages.dev")),
  production_branch: z.string().min(1),
  domains: z.array(hostnameSchema).default([]),
});
const envelopeSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
  result_info: z.object({ total_pages: z.number().int().positive().optional() }).optional(),
});
const policySchema = z.object({
  decision: z.string(),
  include: z.array(z.unknown()).default([]),
});
const accessAppSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  domain: z.string().optional(),
  self_hosted_domains: z.array(z.string()).optional(),
  destinations: z
    .array(
      z.object({
        type: z.string().optional(),
        uri: z.string().optional(),
        overrides: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});
type AccessApp = z.infer<typeof accessAppSchema>;

export interface CloudflareConfig {
  readonly token: string;
  readonly accountId: string;
  readonly accessEmail?: string;
  /** Existing custom hostname attached to this Pages project. */
  readonly pagesHost?: string;
}
export type CloudflareFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{
  readonly status: number;
  readonly json: () => Promise<unknown>;
}>;
export interface PreparedCloudflarePublish {
  readonly project: string;
  readonly hostname: string;
  readonly pagesHostname: string;
  readonly url: string;
  readonly productionBranch: string;
  readonly accessAppIds: readonly string[];
}
export interface CloudflareAsset {
  /** Root-relative URL path, beginning with a slash. */
  readonly path: string;
  readonly contentType: string;
  /** Lazy read keeps a snapshot's files out of memory between uploads. */
  readonly read: () => Promise<Uint8Array>;
}
export interface CloudflareDeployResult {
  readonly url: string;
  readonly deploymentUrl: string;
  readonly accessAppIds: readonly string[];
}

/** Resolve the real hostname and complete private protection before content can leave. */
export async function prepareCloudflarePublish(
  config: CloudflareConfig,
  project: string,
  visibility: "public" | "private",
  pageDir: string,
  fetchImpl: CloudflareFetch,
): Promise<PreparedCloudflarePublish> {
  if (visibility === "private" && !z.email().safeParse(config.accessEmail).success) {
    throw new Error("Private publishing requires a valid accessEmail in the Cloudflare config.");
  }
  const endpoint = `${CF_BASE}/accounts/${config.accountId}/pages/projects`;
  const response = await fetchImpl(`${endpoint}/${project}`, {
    method: "GET",
    headers: auth(config),
  });
  const metadata =
    response.status === 404
      ? await request(fetchImpl, `${endpoint}`, "POST", config, {
          name: project,
          production_branch: "main",
        })
      : await resultOf(response, "Cloudflare Pages project lookup");
  const parsed = projectSchema.parse(metadata);
  const hostname = config.pagesHost ?? parsed.subdomain;
  if (
    !hostnameSchema.safeParse(hostname).success ||
    (hostname !== parsed.subdomain && !parsed.domains.includes(hostname))
  ) {
    throw new Error("pagesHost must be a hostname attached to this Cloudflare Pages project.");
  }
  const accessAppIds: string[] = [];
  if (visibility === "private") {
    const domains = [parsed.subdomain, `*.${parsed.subdomain}`, ...parsed.domains];
    const scopes = [
      ...new Set(
        domains.map((domain) =>
          domain === config.pagesHost && domain !== parsed.subdomain
            ? `${domain}/compositions/private`
            : domain,
        ),
      ),
    ];
    await ensureAccess(fetchImpl, config, project, scopes, accessAppIds);
  }
  return {
    project,
    hostname,
    pagesHostname: parsed.subdomain,
    productionBranch: parsed.production_branch,
    url: `https://${hostname}/${pageDir}/`,
    accessAppIds,
  };
}

/** Upload every retained page, then publish one complete production snapshot. */
export async function deployToCloudflare(
  config: CloudflareConfig,
  prepared: PreparedCloudflarePublish,
  assets: readonly CloudflareAsset[],
  fetchImpl: CloudflareFetch,
): Promise<CloudflareDeployResult> {
  if (assets.length === 0 || assets.length > MAX_ASSETS) {
    throw new Error(`Cloudflare Pages snapshots require 1–${MAX_ASSETS} assets.`);
  }
  const base = `${CF_BASE}/accounts/${config.accountId}/pages/projects/${prepared.project}`;
  const token = z
    .object({ jwt: z.string().min(1) })
    .parse(await request(fetchImpl, `${base}/upload-token`, "GET", config)).jwt;
  const manifest: Record<string, string> = {};
  for (const asset of assets) {
    if (
      !asset.path.startsWith("/") ||
      asset.path.includes("\\") ||
      asset.path.split("/").some((segment) => segment === ".." || segment === ".") ||
      Object.hasOwn(manifest, asset.path)
    ) {
      throw new Error("Cloudflare assets must have unique root-relative paths.");
    }
    const bytes = await asset.read();
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new Error("Cloudflare Pages assets cannot exceed 25 MiB.");
    const value = Buffer.from(bytes).toString("base64");
    const hash = Buffer.from(blake3(new TextEncoder().encode(value + extname(asset.path).slice(1))))
      .toString("hex")
      .slice(0, 32);
    const assetConfig = { ...config, token };
    const missing = z.array(z.string()).parse(
      await request(fetchImpl, `${CF_BASE}/pages/assets/check-missing`, "POST", assetConfig, {
        hashes: [hash],
      }),
    );
    if (missing.includes(hash)) {
      await request(fetchImpl, `${CF_BASE}/pages/assets/upload`, "POST", assetConfig, [
        {
          key: hash,
          value,
          metadata: { contentType: asset.contentType },
          base64: true,
        },
      ]);
      await request(fetchImpl, `${CF_BASE}/pages/assets/upsert-hashes`, "POST", assetConfig, {
        hashes: [hash],
      });
    }
    manifest[asset.path] = hash;
  }
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", prepared.productionBranch);
  form.append("commit_message", "jazz publish_composition");
  const response = await fetchImpl(`${base}/deployments`, {
    method: "POST",
    headers: auth(config),
    body: form,
  });
  const deployment = z
    .object({ url: z.url() })
    .parse(await resultOf(response, "Cloudflare deployment"));
  const deploymentHost = new URL(deployment.url).hostname;
  if (
    new URL(deployment.url).protocol !== "https:" ||
    (deploymentHost !== prepared.pagesHostname &&
      !deploymentHost.endsWith(`.${prepared.pagesHostname}`))
  ) {
    throw new Error("Cloudflare returned a deployment URL outside the prepared project.");
  }
  return { url: prepared.url, deploymentUrl: deployment.url, accessAppIds: prepared.accessAppIds };
}

/** Match overlapping scopes conservatively so a narrower bypass app cannot win routing. */
function overlaps(left: string, right: string): boolean {
  const [leftHost = "", ...leftPath] = left.split("/");
  const [rightHost = "", ...rightPath] = right.split("/");
  const hostMatches = (pattern: string, host: string): boolean =>
    pattern === host || (pattern.startsWith("*.") && host.endsWith(pattern.slice(1)));
  if (!hostMatches(leftHost, rightHost) && !hostMatches(rightHost, leftHost)) return false;
  const l = leftPath.join("/").replace(/\*.*$/, "");
  const r = rightPath.join("/").replace(/\*.*$/, "");
  return !l || !r || l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
}

function appScopes(app: AccessApp): readonly string[] {
  if (app.destinations?.length) {
    return app.destinations.flatMap((destination) => (destination.uri ? [destination.uri] : []));
  }
  return app.self_hosted_domains?.length ? app.self_hosted_domains : app.domain ? [app.domain] : [];
}

async function ensureAccess(
  fetchImpl: CloudflareFetch,
  config: CloudflareConfig,
  project: string,
  scopes: readonly string[],
  appIds: string[],
): Promise<void> {
  const base = `${CF_BASE}/accounts/${config.accountId}/access/apps`;
  const apps: AccessApp[] = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Too many Access apps to verify private publishing safely.");
    const response = await fetchImpl(`${base}?per_page=50&page=${page}`, {
      method: "GET",
      headers: auth(config),
    });
    const envelope = await envelopeOf(response, "Cloudflare Access app lookup");
    const batch = z.array(accessAppSchema).parse(envelope.result);
    apps.push(...batch);
    if (
      envelope.result_info?.total_pages
        ? page >= envelope.result_info.total_pages
        : batch.length < 50
    )
      break;
  }
  for (const app of apps) {
    if (!appScopes(app).some((uri) => scopes.some((scope) => overlaps(uri, scope)))) continue;
    if (
      app.type !== "self_hosted" ||
      app.destinations?.some((destination) => destination.overrides?.length)
    ) {
      throw new Error("An existing Access app has incompatible destinations or public overrides.");
    }
    await verifyEmailPolicies(fetchImpl, config, app.id);
  }
  for (const scope of scopes) {
    const existing = apps.find((app) => appScopes(app).includes(scope));
    if (existing) {
      appIds.push(existing.id);
      continue;
    }
    const created = accessAppSchema.parse(
      await request(fetchImpl, base, "POST", config, {
        type: "self_hosted",
        name: `jazz-${project}-${appIds.length + 1}`,
        session_duration: "24h",
        domain: scope,
        policies: [
          {
            name: "jazz-allow-email",
            decision: "allow",
            include: [{ email: { email: config.accessEmail } }],
          },
        ],
      }),
    );
    if (!appScopes(created).includes(scope))
      throw new Error("Cloudflare Access did not confirm the requested scope.");
    await verifyEmailPolicies(fetchImpl, config, created.id);
    appIds.push(created.id);
  }
}

/** Check every applicable app, including newly created apps, for authenticated email rules. */
async function verifyEmailPolicies(
  fetchImpl: CloudflareFetch,
  config: CloudflareConfig,
  appId: string,
): Promise<void> {
  const policies: z.infer<typeof policySchema>[] = [];
  for (let page = 1; ; page++) {
    if (page > 100)
      throw new Error("Too many Access policies to verify private publishing safely.");
    const url = `${CF_BASE}/accounts/${config.accountId}/access/apps/${appId}/policies?per_page=50&page=${page}`;
    const envelope = await envelopeOf(
      await fetchImpl(url, { method: "GET", headers: auth(config) }),
      "Cloudflare Access policy lookup",
    );
    const batch = z.array(policySchema).parse(envelope.result);
    policies.push(...batch);
    if (
      envelope.result_info?.total_pages
        ? page >= envelope.result_info.total_pages
        : batch.length < 50
    )
      break;
  }
  const safeInclude = z.union([
    z.object({ email: z.object({ email: z.email() }) }).strict(),
    z.object({ email_domain: z.object({ domain: hostnameSchema }) }).strict(),
  ]);
  if (
    !policies.some((policy) => policy.decision === "allow") ||
    policies.some(
      (policy) =>
        (policy.decision !== "allow" &&
          policy.decision !== "deny" &&
          policy.decision !== "block") ||
        (policy.decision === "allow" &&
          (policy.include.length === 0 ||
            policy.include.some((rule) => !safeInclude.safeParse(rule).success))),
    )
  ) {
    throw new Error(
      "Existing Access policies must allow email identities and contain no bypass rules.",
    );
  }
}

function auth(config: CloudflareConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.token}` };
}
async function request(
  fetchImpl: CloudflareFetch,
  url: string,
  method: string,
  config: CloudflareConfig,
  body?: unknown,
): Promise<unknown> {
  const headers = auth(config);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return resultOf(await fetchImpl(url, init), `Cloudflare API ${method} ${new URL(url).pathname}`);
}
async function envelopeOf(
  response: Awaited<ReturnType<CloudflareFetch>>,
  operation: string,
): Promise<z.infer<typeof envelopeSchema>> {
  const parsed = envelopeSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`${operation} returned an invalid response.`);
  if (response.status < 200 || response.status >= 300 || !parsed.data.success) {
    throw new Error(
      `${operation} failed: ${parsed.data.errors?.[0]?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return parsed.data;
}
async function resultOf(
  response: Awaited<ReturnType<CloudflareFetch>>,
  operation: string,
): Promise<unknown> {
  return (await envelopeOf(response, operation)).result;
}
