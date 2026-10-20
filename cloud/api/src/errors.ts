/**
 * Fixed, sanitised API error envelopes.
 *
 * Raw exception messages, request bodies, headers, paths, and environment values
 * must never reach a response or a log. Callers select a known code and message
 * from this module instead of forwarding framework or runtime error text.
 */

export type ApiErrorCode =
  | 'invalid-json'
  | 'payload-too-large'
  | 'unsupported-media-type'
  | 'invalid-request'
  | 'unauthenticated'
  | 'not-found'
  | 'unavailable'
  | 'internal-error';

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

export interface ApiErrorResponse {
  statusCode: number;
  envelope: ApiErrorEnvelope;
}

const MESSAGES = {
  invalidJson: 'The request body is not valid JSON.',
  payloadTooLarge: 'The request body is too large.',
  unsupportedMediaType: 'The request content type is not supported.',
  invalidRequest: 'The request is invalid.',
  unauthenticated: 'Authentication is required.',
  notFound: 'The requested resource was not found.',
  unavailable: 'The service is not ready.',
  internal: 'An internal error occurred.',
} as const;

export function apiErrorEnvelope(
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  requestID: string,
): ApiErrorEnvelope {
  return { error: { code, message, retryable, requestID } };
}

/**
 * Map an arbitrary thrown value to a sanitised response description.
 *
 * Only known Fastify content-negotiation/parser codes and a small allow-list of
 * HTTP statuses influence the result. The thrown message is never copied.
 */
export function toApiErrorResponse(
  error: unknown,
  requestID: string,
): ApiErrorResponse {
  const code = readErrorCode(error);
  const statusCode = readErrorStatusCode(error);

  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return response(413, 'payload-too-large', MESSAGES.payloadTooLarge, false, requestID);
  }
  if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return response(400, 'invalid-json', MESSAGES.invalidJson, false, requestID);
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return response(415, 'unsupported-media-type', MESSAGES.unsupportedMediaType, false, requestID);
  }
  if (code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' || code === 'FST_ERR_VALIDATION') {
    return response(400, 'invalid-request', MESSAGES.invalidRequest, false, requestID);
  }

  if (statusCode === 400 || hasValidationErrors(error)) {
    return response(400, 'invalid-request', MESSAGES.invalidRequest, false, requestID);
  }
  if (statusCode === 401) {
    return response(401, 'unauthenticated', MESSAGES.unauthenticated, false, requestID);
  }
  if (statusCode === 404) {
    return response(404, 'not-found', MESSAGES.notFound, false, requestID);
  }
  if (statusCode === 413) {
    return response(413, 'payload-too-large', MESSAGES.payloadTooLarge, false, requestID);
  }
  if (statusCode === 415) {
    return response(415, 'unsupported-media-type', MESSAGES.unsupportedMediaType, false, requestID);
  }
  if (statusCode === 503) {
    return response(503, 'unavailable', MESSAGES.unavailable, true, requestID);
  }

  return response(500, 'internal-error', MESSAGES.internal, false, requestID);
}

function response(
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  requestID: string,
): ApiErrorResponse {
  return {
    statusCode,
    envelope: apiErrorEnvelope(code, message, retryable, requestID),
  };
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function readErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (
    typeof statusCode !== 'number' ||
    !Number.isInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599
  ) {
    return undefined;
  }
  return statusCode;
}

function hasValidationErrors(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('validation' in error)) {
    return false;
  }
  const validation = (error as { validation?: unknown }).validation;
  return Array.isArray(validation) && validation.length > 0;
}
