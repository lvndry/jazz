/** Static manifest and immutable artifact routes for reviewed first-party plugins. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface CatalogRoute {
  readonly path: string;
  readonly file: string;
  readonly contentType: string;
}

const routesPath = fileURLToPath(
  new URL("../../../../../.build/plugin-catalog/routes.json", import.meta.url),
);

export async function getStaticPaths() {
  const routes = JSON.parse(await readFile(routesPath, "utf8")) as CatalogRoute[];
  return routes.map((route) => ({ params: { path: route.path }, props: route }));
}

export async function GET({ props }: { props: CatalogRoute }): Promise<Response> {
  return new Response(await readFile(props.file), {
    headers: {
      "Content-Type": props.contentType,
      "Cache-Control": props.path.endsWith(".mjs")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
    },
  });
}
