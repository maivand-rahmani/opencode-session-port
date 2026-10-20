/**
 * Disabled upload service boundary.
 *
 * M4 storage integration is not implemented or authorized here. This factory
 * takes no repository, database, S3 client, configuration, environment, or
 * provider switch. Both operations fail before any dependency could be called.
 *
 * There is intentionally no enable flag, provider option, environment override,
 * or injectable repository. A future M4 integration must replace this boundary
 * explicitly rather than flipping a runtime toggle.
 */

export type UploadServiceErrorCode = 'upload-service-unavailable';

export class UploadServiceUnavailableError extends Error {
  readonly code: UploadServiceErrorCode = 'upload-service-unavailable';
  readonly statusCode = 503;
  readonly retryable = true;

  constructor() {
    super('The upload service is unavailable.');
    this.name = 'UploadServiceUnavailableError';
  }
}

export interface UploadService {
  /** Reserve a staging target. Rejected while uploads are disabled. */
  reserve(input: unknown): Promise<never>;
  /** Finalize an upload. Rejected while uploads are disabled. */
  complete(input: unknown): Promise<never>;
}

/**
 * Build the fail-closed upload service. `arguments` is not inspected, no
 * environment variable is read, and no network call is possible: the returned
 * object closes over nothing.
 */
export function createDisabledUploadService(): UploadService {
  const reject = async (): Promise<never> => {
    throw new UploadServiceUnavailableError();
  };

  return Object.freeze({
    reserve: reject,
    complete: reject,
  });
}
