import { GaxiosError } from "gaxios";

/**
 * Extract HTTP status code from gaxios errors.
 *
 * This utility function safely extracts HTTP status codes from GaxiosError instances,
 * which are commonly thrown by Google API clients (gmail, calendar, etc.).
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
  if (error instanceof GaxiosError) {
    return error.status ?? error.response?.status;
  }
  return undefined;
}
