/**
 * Extract HTTP status code from HTTP client errors.
 *
 * Google API clients often throw errors with a `status` and/or `response.status` shape.
 *
 * @param error - The unknown error to extract status from
 * @returns The HTTP status code if available, undefined otherwise
 *
 * @example
 * ```ts
 * try {
 *   await googleApiCall();
 * } catch (error) {
 *   const status = getHttpStatusFromError(error);
 *   if (status === 401) {
 *     // Handle authentication error
 *   }
 * }
 * ```
 */
export function getHttpStatusFromError(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;

  const status = error["status"];
  if (typeof status === "number") return status;

  const response = error["response"];
  if (isRecord(response) && typeof response["status"] === "number") return response["status"];

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
