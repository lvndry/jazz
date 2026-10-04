/**
 * Cloudflare Pages deploy + Access, via the asset API (wrangler's protocol):
 * upload-token (JWT) → asset upload → upsert-hashes → deployment manifest.
 *
 * For git-integrated projects (the reliable path on most accounts —
 * direct-upload deploys 500 at the edge) the tool has already pushed the
 * files to the repo, so the upload here is a best-effort warm-up of the
 * preview and the git build is what serves production.
 *
 * Access: private projects get a self-hosted Access app. When the host is a
 * claimed custom subdomain (lvndry.pages.dev) the app is PATH-scoped to
 * /compositions/private so the public pages on the same host stay open.
 *
 * `fetch` is injected so tests exercise the whole sequence offline.
 */

import { createHash } from "node:crypto";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export type CloudflareConfig = {
  token: string;
  accountId: string;
  /** Email that the private page's Access policy allows (e.g. "me@email.com"). */
  accessEmail?: string;
  /** Claimed custom pages.dev subdomain, e.g. "lvndry.pages.dev". */
  pagesHost?: string;
};

export type CloudflareFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export type CloudflareDeployResult = {
  /** Canonical URL of the published page. */
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

/** What ships in a page: the HTML plus the optional OG card. */
export type CloudflareAssets = {
  readonly indexHtml: string;
  readonly ogPng?: Buffer;
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
  /** Path restriction ("" or absent = whole domain). */
  readonly path?: string;
};

/**
 * Deploy a page (HTML + optional og.png) to a Cloudflare Pages project under
 * `pageDir`, and (for private projects) ensure an Access app gating the page
 * exists with an allow policy for the configured email.
 */
export async function deployToCloudflare(
  config: CloudflareConfig,
  project: string,
  pageDir: string,
  assets: CloudflareAssets,
  fetchImpl: CloudflareFetch,
): Promise<CloudflareDeployResult> {
  const auth: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  const aid = config.accountId;
  const hostBase = config.pagesHost ?? `${project}.pages.dev`;
  const url = `https://${hostBase}/${pageDir}`;
  const isPrivate = project.endsWith("-private");
  // Path-scoped Access only makes sense on the shared custom host; on the
  // default <project>.pages.dev the whole domain is private anyway.
  const accessPath = isPrivate && config.pagesHost ? "/compositions/private" : undefined;

  await ensureProject(fetchImpl, auth, aid, project);
  await uploadPage(fetchImpl, auth, aid, project, assets);

  // Best-effort deployment for the preview; on git-integrated projects the
  // push already triggered the real build.
  let previewUrl = "";
  try {
    const deployment = await deployManifest(fetchImpl, auth, aid, project, pageDir, assets);
    previewUrl = deployment.url ?? url;
  } catch {
    // On a git-integrated project the push is the real deploy.
  }

  if (isPrivate) {
    const access = await ensureAccess(fetchImpl, auth, config, project, hostBase, accessPath);
    return {
      url,
      previewUrl: previewUrl || url,
      accessPreexisting: access.preexisting,
      ...(access.appId ? { accessAppId: access.appId } : {}),
      accessNeedsEmail: access.needsEmail,
    };
  }
  return { url, previewUrl: previewUrl || url, accessPreexisting: false, accessNeedsEmail: false };
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

async function uploadAsset(
  fetchImpl: CloudflareFetch,
  assetHeaders: Record<string, string>,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const missing = await cfJson<string[]>(
    fetchImpl,
    `${CF_BASE}/pages/assets/check-missing`,
    "POST",
    assetHeaders,
    { hashes: [hash] },
  );
  if (!(missing ?? []).includes(hash)) return;
  await cfJson(fetchImpl, `${CF_BASE}/pages/assets/upload`, "POST", assetHeaders, [
    {
      key: hash,
      value: Buffer.from(bytes).toString("base64"),
      metadata: { contentType },
      base64: true,
    },
  ]);
  await cfJson(fetchImpl, `${CF_BASE}/pages/assets/upsert-hashes`, "POST", assetHeaders, {
    hashes: [hash],
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

async function uploadPage(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  accountId: string,
  project: string,
  assets: CloudflareAssets,
): Promise<void> {
  const jwt = await getUploadToken(fetchImpl, auth, accountId, project);
  const assetHeaders: Record<string, string> = { Authorization: `Bearer ${jwt}` };
  await uploadAsset(fetchImpl, assetHeaders, Buffer.from(assets.indexHtml, "utf8"), "text/html");
  if (assets.ogPng && assets.ogPng.length > 0) {
    await uploadAsset(fetchImpl, assetHeaders, assets.ogPng, "image/png");
  }
}

/** Multipart deployment manifest mapping the page files to their asset hashes. */
async function deployManifest(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  accountId: string,
  project: string,
  pageDir: string,
  assets: CloudflareAssets,
): Promise<{ url?: string }> {
  const manifest: Record<string, string> = {
    [`${pageDir}/index.html`]: createHash("sha256").update(assets.indexHtml, "utf8").digest("hex"),
  };
  if (assets.ogPng && assets.ogPng.length > 0) {
    manifest[`${pageDir}/og.png`] = createHash("sha256").update(assets.ogPng).digest("hex");
  }
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("commit_message", `jazz publish_composition: ${pageDir}`);
  const r = await fetchImpl(
    `${CF_BASE}/accounts/${accountId}/pages/projects/${project}/deployments`,
    { method: "POST", headers: auth, body: form },
  );
  const b = (await r.json()) as CfJson<{ url?: string }>;
  if (r.status !== 200 || b.success === false) {
    throw new Error(`Cloudflare deployment failed: ${firstError(b)}`);
  }
  return b.result ?? {};
}

/**
 * Ensure an Access app gating `domain` (optionally restricted to `path`) with
 * an allow policy for the configured email. A pre-existing app on the domain
 * is left untouched — the person owns it (emails are managed in the
 * Cloudflare One dashboard).
 */
async function ensureAccess(
  fetchImpl: CloudflareFetch,
  auth: Record<string, string>,
  config: CloudflareConfig,
  project: string,
  domain: string,
  path: string | undefined,
): Promise<{ preexisting: boolean; appId?: string; needsEmail: boolean }> {
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
      ...(path ? { path } : {}),
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
  await cfJson(
    fetchImpl,
    `${CF_BASE}/accounts/${aid}/access/apps/${appId}/policies`,
    "POST",
    auth,
    {
      name: "jazz-allow-email",
      decision: "allow",
      include: [{ email: { email: config.accessEmail } }],
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

function firstError(b: CfJson): string {
  return b.errors?.[0]?.message ?? "unknown error";
}
