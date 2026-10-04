/**
 * Cloudflare Pages deploy via the asset API (wrangler's protocol):
 * upload-token (JWT) → asset upload → upsert-hashes → deployment manifest.
 *
 * A git-integrated project is also acceptable: the tool pushes to the repo
 * first, and if the project is already connected to that repo in the
 * dashboard, the deploy below is a harmless redeploy of the same assets.
 *
 * `fetch` is injected so tests exercise the whole sequence offline.
 */

import { createHash } from "node:crypto";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export type CloudflareConfig = {
  token: string;
  accountId: string;
  /** Email that the private page's Access policy allows (e.g. "me@example.com"). */
  accessEmail?: string;
};

export type CloudflareFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export type CloudflareDeployResult = {
  /** Canonical URL, e.g. https://compositions-private.pages.dev/secret.html */
  readonly url: string;
  /** Short-id preview URL from the deployment response. */
  readonly previewUrl: string;
  /** True when an Access app already gated the domain before this call. */
  readonly accessPreexisting: boolean;
  /** The Access app id created or found, when access was set up or present. */
  readonly accessAppId?: string;
  /** True when the Access app exists but no allow-email policy could be set (no email configured). */
  readonly accessNeedsEmail: boolean;
};

type CfJson<T = unknown> = {
  readonly success?: boolean;
  readonly result?: T;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
};

/** The shape of a Cloudflare Access self-hosted app we create or find. */
type AccessApp = {
  readonly id?: string;
  readonly domain?: string;
};

/**
 * Deploy one HTML file to a Cloudflare Pages project, and (for projects whose
 * name ends in `-private`) ensure a self-hosted Access app with an
 * allow-your-email policy exists on the project's domain.
 */
export async function deployToCloudflare(
  config: CloudflareConfig,
  project: string,
  slug: string,
  fileBytes: Uint8Array,
  fetchImpl: CloudflareFetch,
): Promise<CloudflareDeployResult> {
  const auth: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  const aid = config.accountId;
  const hash = createHash("sha256").update(fileBytes).digest("hex");
  const pathKey = `/${slug}.html`;
  const url = `https://${project}.pages.dev/${slug}.html`;

  await ensureProject(fetchImpl, auth, aid, project);

  const jwt = await getUploadToken(fetchImpl, auth, aid, project);
  const assetHeaders: Record<string, string> = { Authorization: `Bearer ${jwt}` };

  const missing = await cfJson<string[]>(
    fetchImpl,
    `${CF_BASE}/pages/assets/check-missing`,
    "POST",
    assetHeaders,
    { hashes: [hash] },
  );
  if ((missing ?? []).includes(hash)) {
    await cfJson(fetchImpl, `${CF_BASE}/pages/assets/upload`, "POST", assetHeaders, [
      {
        key: hash,
        value: Buffer.from(fileBytes).toString("base64"),
        metadata: { contentType: "text/html" },
        base64: true,
      },
    ]);
    await cfJson(fetchImpl, `${CF_BASE}/pages/assets/upsert-hashes`, "POST", assetHeaders, {
      hashes: [hash],
    });
  }

  // Deployment: multipart form with a `manifest` field mapping paths to asset hashes.
  const form = new FormData();
  form.append("manifest", JSON.stringify({ [pathKey]: hash }));
  form.append("commit_message", `jazz publish_composition: ${slug}`);
  const deployment = await cfForm(fetchImpl, auth, aid, project, form);
  const previewUrl = deployment.url ?? url;

  if (project.endsWith("-private")) {
    const access = await ensureAccess(fetchImpl, auth, config, project);
    return {
      url,
      previewUrl,
      accessPreexisting: access.preexisting,
      ...(access.appId ? { accessAppId: access.appId } : {}),
      accessNeedsEmail: access.needsEmail,
    };
  }
  return { url, previewUrl, accessPreexisting: false, accessNeedsEmail: false };
}

async function ensureProject(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  accountId: string,
  project: string,
): Promise<void> {
  const r = await fetchImpl(`${CF_BASE}/accounts/${accountId}/pages/projects/${project}`, {
    method: "GET",
    headers: auth,
  });
  if (r.status === 200) return;
  if (r.status !== 404) {
    const b = (await r.json()) as CfJson;
    throw new Error(`Cloudflare Pages project check failed: ${firstError(b)}`);
  }
  await cfJson(fetchImpl, `${CF_BASE}/accounts/${accountId}/pages/projects`, "POST", auth, {
    name: project,
    production_branch: "main",
  });
}

async function getUploadToken(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  accountId: string,
  project: string,
): Promise<string> {
  const r = await cfJson<{ jwt?: unknown }>(
    fetchImpl,
    `${CF_BASE}/accounts/${accountId}/pages/projects/${project}/upload-token`,
    "GET",
    auth,
    undefined,
  );
  const jwt = r?.jwt;
  if (typeof jwt !== "string" || jwt.length === 0) {
    throw new Error("Cloudflare upload-token response had no jwt");
  }
  return jwt;
}

/**
 * Ensure a self-hosted Access app + an allow policy on the domain.
 *
 * The allow rule is domain-scoped (`email_domain`): every account signed in
 * with that email domain is admitted. Per-address rules are managed in the
 * Cloudflare One dashboard (Access → Applications → the app → Policies).
 */
async function ensureAccess(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  config: CloudflareConfig,
  project: string,
): Promise<{ preexisting: boolean; appId?: string; needsEmail: boolean }> {
  const domain = `${project}.pages.dev`;
  const aid = config.accountId;

  const apps = await cfJson<AccessApp[]>(
    fetchImpl,
    `${CF_BASE}/accounts/${aid}/access/apps?limit=50`,
    "GET",
    auth,
    undefined,
  );
  const list: AccessApp[] = Array.isArray(apps) ? apps : (apps ?? []);
  const existing = list.find((a) => a?.domain === domain);
  if (existing) {
    // Do not rewrite a user-tuned app; just report it.
    return {
      preexisting: true,
      ...(existing.id ? { appId: existing.id } : {}),
      needsEmail: false,
    };
  }

  const created = await cfJson<AccessApp>(
    fetchImpl,
    `${CF_BASE}/accounts/${aid}/access/apps`,
    "POST",
    auth,
    {
      type: "self_hosted",
      name: `jazz-${project}`,
      session_duration: "24h",
      domain,
    },
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not_enabled")) {
      throw new Error(
        "Cloudflare Access is not enabled on this account. Open https://one.dash.cloudflare.com/ → Access and click Enable Access, then re-publish.",
      );
    }
    throw error;
  });
  const appId = created?.id;
  if (typeof appId !== "string" || appId.length === 0) {
    throw new Error("Cloudflare Access app created but no id returned");
  }
  if (!config.accessEmail) {
    return { preexisting: false, appId, needsEmail: true };
  }
  const emailDomain = config.accessEmail.includes("@")
    ? (config.accessEmail.split("@").pop() ?? config.accessEmail)
    : config.accessEmail;
  await cfJson(
    fetchImpl,
    `${CF_BASE}/accounts/${aid}/access/apps/${appId}/policies`,
    "POST",
    auth,
    {
      name: "jazz-allow-email",
      decision: "allow",
      include: [{ email_domain: { domain: emailDomain } }],
    },
  );
  return { preexisting: false, appId, needsEmail: false };
}

async function cfJson<T>(
  fetchImpl: CloudflareFetch,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T | undefined> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { ...headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetchImpl(url, init);
  const b = (await r.json()) as CfJson<T>;
  if (r.status !== 200 || b.success === false) {
    throw new Error(`Cloudflare API ${method} ${new URL(url).pathname} failed: ${firstError(b)}`);
  }
  return b.result;
}

/** Deployment accepts a multipart form; the runtime sets the Content-Type. */
async function cfForm(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  accountId: string,
  project: string,
  form: FormData,
): Promise<{ url?: string }> {
  const r = await fetchImpl(
    `${CF_BASE}/accounts/${accountId}/pages/projects/${project}/deployments`,
    {
      method: "POST",
      headers: auth,
      body: form,
    },
  );
  const b = (await r.json()) as CfJson<{ url?: string }>;
  if (r.status !== 200 || b.success === false) {
    throw new Error(`Cloudflare deployment failed: ${firstError(b)}`);
  }
  return b.result ?? {};
}

function firstError(b: CfJson): string {
  return b.errors?.[0]?.message ?? "unknown error";
}
