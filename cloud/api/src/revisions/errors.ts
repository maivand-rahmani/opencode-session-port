/**
 * Fixed, public-safe revision module errors.
 *
 * Codes and messages are module-local constants. Driver text, identifiers,
 * ciphertext fields, SQL, and request values are never copied into an error,
 * an envelope, or a log. The global API error catalogue is intentionally not
 * extended here; routes can use the existing `apiErrorEnvelope` for generic
 * transport failures and this module for revision-domain failures.
 */

export type RevisionRepositoryErrorCode =
  | 'invalid-revision-input'
  | 'invalid-cursor'
  | 'invalid-page-limit'
  | 'project-not-found'
  | 'unknown-parent'
  | 'parent-required'
  | 'upload-not-ready'
  | 'revision-conflict'
  | 'device-not-found'
  | 'internal-error'
  | 'repository-unavailable';

interface RevisionRepositoryErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

const ERROR_DEFINITIONS: Readonly<
  Record<RevisionRepositoryErrorCode, RevisionRepositoryErrorDefinition>
> = {
  'invalid-revision-input': {
    statusCode: 422,
    retryable: false,
    message: 'Revision repository input is invalid.',
  },
  'invalid-cursor': {
    statusCode: 422,
    retryable: false,
    message: 'The cursor is invalid.',
  },
  'invalid-page-limit': {
    statusCode: 422,
    retryable: false,
    message: 'The page limit is invalid.',
  },
  'project-not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The project was not found.',
  },
  'unknown-parent': {
    statusCode: 422,
    retryable: false,
    message: 'The parent revision was not found.',
  },
  'parent-required': {
    statusCode: 422,
    retryable: false,
    message: 'A parent revision is required.',
  },
  'upload-not-ready': {
    statusCode: 409,
    retryable: false,
    message: 'The upload is not ready for commit.',
  },
  'revision-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The revision identifier is unavailable for these fields.',
  },
  'device-not-found': {
    statusCode: 409,
    retryable: false,
    message: 'The device is not active for this user.',
  },
  'internal-error': {
    statusCode: 500,
    retryable: false,
    message: 'An internal revision error occurred.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The revision service is temporarily unavailable.',
  },
};

export class RevisionRepositoryError extends Error {
  readonly code: RevisionRepositoryErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: RevisionRepositoryErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'RevisionRepositoryError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

export interface RevisionErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

/**
 * Build the fixed lowercase error envelope used by the revision routes. The
 * caller must supply a constant code and message from this module or another
 * reviewed fixed catalogue.
 */
export function revisionErrorEnvelope(
  code: string,
  message: string,
  retryable: boolean,
  requestID: string,
): RevisionErrorEnvelope {
  return { error: { code, message, retryable, requestID } };
}
