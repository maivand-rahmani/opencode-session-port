/**
 * Tenant-scoped upload reservation and finalization records.
 *
 * This module implements database records and quota accounting only. It does
 * not sign S3 requests, copy objects, mount an HTTP route, or enable uploads.
 * Client input is limited to opaque identifiers, sizes, `keyEpoch`, and a
 * 32-byte ciphertext digest; no plaintext payload field exists.
 *
 * Lock order for every quota-changing operation is `UserQuota` then `Upload`.
 * Lease acquisition changes no quota and locks only `Upload`.
 *
 * `VerifiedStorageObject` is an explicit trusted internal seam, not a public
 * request type. Only a future storage integration (M4) may construct it after
 * HEAD/copy verification. Passing an object at runtime is not proof that S3
 * verified anything; this repository cannot and does not claim that.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../prisma/generated/client/client.js';
import {
  QuotaAccountingError,
  addReservedBytes,
  assertReservationAllowed,
  lockQuotaForUpdate,
  moveReservedToUsed,
  releaseReservedBytes,
  type QuotaAccountingErrorCode,
} from '../quota/accounting.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const MAX_USER_ID_LENGTH = 1_024;
const MAX_LEASE_OWNER_LENGTH = 1_024;
const MAX_KEY_LENGTH = 2_048;
const MAX_SAFE_MILLISECONDS = Number.MAX_SAFE_INTEGER;

const ACTIVE_INTENT_STATES = [
  'uploading',
  'finalizing',
  'ready',
  'deleting',
] as const;

const UPLOAD_SELECT = {
  uploadID: true,
  userID: true,
  projectID: true,
  deviceID: true,
  revisionID: true,
  parentRevisionID: true,
  keyEpoch: true,
  stagingKey: true,
  finalKey: true,
  state: true,
  sizeBytes: true,
  ciphertextSha256: true,
  leaseToken: true,
  leaseOwner: true,
  leaseExpiresAt: true,
  expiresAt: true,
  graceExpiresAt: true,
  createdAt: true,
  completedAt: true,
} as const;

const DEVICE_SELECT = {
  id: true,
  userID: true,
  grant: {
    select: {
      status: true,
      expiresAt: true,
    },
  },
} as const;

const PROJECT_SELECT = { projectID: true } as const;
const REVISION_SELECT = { revisionID: true } as const;

export type UploadStateName =
  | 'uploading'
  | 'finalizing'
  | 'ready'
  | 'deleting'
  | 'deleted'
  | 'expired';

export type UploadRepositoryErrorCode =
  | 'invalid-upload-input'
  | 'device-not-authorized'
  | 'project-not-found'
  | 'parent-revision-not-found'
  | 'revision-already-committed'
  | 'upload-conflict'
  | 'upload-not-found'
  | 'upload-expired'
  | 'upload-state-conflict'
  | 'ciphertext-too-large'
  | 'storage-limit-reached'
  | 'quota-not-provisioned'
  | 'quota-invalid'
  | 'quota-underflow'
  | 'repository-unavailable';

interface UploadRepositoryErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

// Fixed, public-safe messages. No identifiers, keys, SQL, or driver text.
const ERROR_DEFINITIONS: Readonly<
  Record<UploadRepositoryErrorCode, UploadRepositoryErrorDefinition>
> = {
  'invalid-upload-input': {
    statusCode: 422,
    retryable: false,
    message: 'Upload repository input is invalid.',
  },
  'device-not-authorized': {
    statusCode: 403,
    retryable: false,
    message: 'The device is not authorized.',
  },
  'project-not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The project was not found.',
  },
  'parent-revision-not-found': {
    statusCode: 422,
    retryable: false,
    message: 'The parent revision was not found.',
  },
  'revision-already-committed': {
    statusCode: 409,
    retryable: false,
    message: 'The revision is already committed.',
  },
  'upload-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The upload conflicts with an existing upload.',
  },
  'upload-not-found': {
    statusCode: 404,
    retryable: false,
    message: 'The upload was not found.',
  },
  'upload-expired': {
    statusCode: 410,
    retryable: false,
    message: 'The upload reservation has expired.',
  },
  'upload-state-conflict': {
    statusCode: 409,
    retryable: false,
    message: 'The upload is not in a valid state for this operation.',
  },
  'ciphertext-too-large': {
    statusCode: 422,
    retryable: false,
    message: 'The ciphertext size exceeds the configured limit.',
  },
  'storage-limit-reached': {
    statusCode: 413,
    retryable: false,
    message: 'The storage limit has been reached.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  'quota-invalid': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota accounting is invalid.',
  },
  'quota-underflow': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota accounting is inconsistent.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The upload repository is temporarily unavailable.',
  },
};

export class UploadRepositoryError extends Error {
  readonly code: UploadRepositoryErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: UploadRepositoryErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'UploadRepositoryError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

const QUOTA_ERROR_MAP: Readonly<
  Record<QuotaAccountingErrorCode, UploadRepositoryErrorCode>
> = {
  'quota-not-provisioned': 'quota-not-provisioned',
  'ciphertext-too-large': 'ciphertext-too-large',
  'storage-limit-reached': 'storage-limit-reached',
  'quota-invalid': 'quota-invalid',
  'quota-underflow': 'quota-underflow',
};

/**
 * Minimal structural dependency accepted by the factory. Tests can provide a
 * small fake without a mock framework.
 */
export type UploadRepositoryClient = Pick<
  PrismaClient,
  '$transaction' | 'upload' | 'revision' | 'project' | 'device' | 'userQuota'
>;

type UploadTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'upload' | 'revision' | 'project' | 'device' | 'userQuota'
>;

export interface UploadRepositoryPolicy {
  /**
   * Explicit per-upload ciphertext ceiling. No product default is provided.
   * A positive safe integer is required; bigint is accepted for callers that
   * already carry database-sized caps, but must remain safe-integer valued.
   */
  readonly maxCiphertextBytes: number | bigint;
  /** Positive reservation TTL in seconds. Test/owner supplied, no default. */
  readonly reservationTTLSeconds: number;
  /** Positive uncommitted-ready grace TTL in seconds. No default. */
  readonly graceTTLSeconds: number;
  /** Positive finalization lease TTL in seconds. No default. */
  readonly leaseTTLSeconds: number;
}

export interface UploadRepositoryDependencies {
  /** Trusted server clock injection for deterministic tests. */
  readonly now?: () => Date;
  /** Trusted UUID/key factory injection for deterministic tests. */
  readonly createID?: () => string;
}

export interface ReserveUploadInput {
  readonly userID: string;
  readonly deviceID: string;
  readonly projectID: string;
  readonly uploadID: string;
  readonly revisionID: string;
  readonly parentRevisionID?: string | null;
  readonly keyEpoch: 1;
  readonly sizeBytes: number;
  readonly ciphertextSha256: Uint8Array;
}

export interface UploadRecordDTO {
  readonly uploadID: string;
  readonly projectID: string;
  readonly deviceID: string;
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly keyEpoch: number;
  readonly state: UploadStateName;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
  readonly stagingKey: string;
  readonly finalKey: string | null;
  readonly leaseToken: bigint;
  readonly leaseOwner: string | null;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string | null;
  readonly graceExpiresAt: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface ReserveUploadResult {
  readonly idempotent: boolean;
  readonly upload: UploadRecordDTO;
}

export interface AcquireFinalizationLeaseInput {
  readonly userID: string;
  readonly uploadID: string;
  /**
   * Trusted server-owned lease owner. If omitted, the configured UUID factory
   * supplies one. A public route must never forward a client field here.
   */
  readonly leaseOwner?: string;
}

export interface FinalizationLeaseResult {
  readonly outcome: 'leased' | 'in-progress' | 'ready';
  readonly statusCode: 200 | 202;
  readonly upload: UploadRecordDTO;
  readonly leaseToken: bigint;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  /** The only server-allocated destination key for this lease generation. */
  readonly finalKey: string | null;
  readonly retryAfterSeconds?: number;
}

export interface AttachFinalObjectInput {
  readonly userID: string;
  readonly uploadID: string;
  readonly leaseToken: bigint | number;
  readonly leaseOwner: string;
  /**
   * Explicit trusted internal seam. Only a future verified storage integration
   * may provide this after copy + HEAD. It is not obtainable from an HTTP body.
   */
  readonly verifiedStorageObject: VerifiedStorageObject;
}

export interface AttachFinalObjectResult {
  readonly outcome: 'attached' | 'idempotent' | 'stale';
  readonly charged: boolean;
  readonly upload: UploadRecordDTO;
}

export interface ExpireReservationInput {
  readonly userID: string;
  readonly uploadID: string;
}

export interface ExpireReservationResult {
  readonly outcome: 'expired' | 'not-expired' | 'live-lease' | 'terminal';
  readonly released: boolean;
  readonly upload: UploadRecordDTO;
}

declare const VERIFIED_STORAGE_OBJECT_BRAND: unique symbol;

/**
 * Externally verified final object metadata.
 *
 * The brand makes ordinary object literals non-assignable. It does NOT prove
 * that any storage call occurred: only the trusted M4 integration may cast or
 * construct this value after a real HEAD/copy verification.
 */
export interface VerifiedStorageObject {
  readonly [VERIFIED_STORAGE_OBJECT_BRAND]: true;
  readonly finalKey: string;
  readonly sizeBytes: number | bigint;
  readonly ciphertextSha256: Uint8Array;
}

export interface UploadRepository {
  reserve(input: ReserveUploadInput): Promise<ReserveUploadResult>;
  acquireFinalizationLease(
    input: AcquireFinalizationLeaseInput,
  ): Promise<FinalizationLeaseResult>;
  attachFinalObject(
    input: AttachFinalObjectInput,
  ): Promise<AttachFinalObjectResult>;
  expireReservation(
    input: ExpireReservationInput,
  ): Promise<ExpireReservationResult>;
}

interface UploadRow {
  readonly uploadID: string;
  readonly userID: string;
  readonly projectID: string;
  readonly deviceID: string;
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly keyEpoch: number;
  readonly stagingKey: string;
  readonly finalKey: string | null;
  readonly state: UploadStateName;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
  readonly leaseToken: bigint;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly graceExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

interface NormalizedReserveInput {
  readonly userID: string;
  readonly deviceID: string;
  readonly projectID: string;
  readonly uploadID: string;
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly keyEpoch: 1;
  readonly sizeBytes: number;
  readonly sizeBytesBigInt: bigint;
  readonly ciphertextSha256: Uint8Array;
}

interface NormalizedAttachInput {
  readonly userID: string;
  readonly uploadID: string;
  readonly leaseToken: bigint;
  readonly leaseOwner: string;
  readonly verifiedFinalKey: string;
  readonly verifiedSizeBytes: bigint;
  readonly verifiedCiphertextSha256: Uint8Array;
}

interface NormalizedExpireInput {
  readonly userID: string;
  readonly uploadID: string;
}

interface NormalizedPolicy {
  readonly maxCiphertextBytes: bigint;
  readonly reservationTTLMilliseconds: number;
  readonly graceTTLMilliseconds: number;
  readonly leaseTTLMilliseconds: number;
}

interface RepositoryContext {
  readonly client: UploadRepositoryClient;
  readonly policy: NormalizedPolicy;
  readonly now: () => Date;
  readonly createID: () => string;
}

/**
 * Build the records repository. Policy values are validated before the client
 * is captured or used; there are no product defaults.
 */
export function createUploadRepository(
  client: UploadRepositoryClient,
  policy: UploadRepositoryPolicy,
  dependencies: UploadRepositoryDependencies = {},
): UploadRepository {
  const context: RepositoryContext = Object.freeze({
    client,
    policy: readPolicy(policy),
    now: readNow(dependencies.now),
    createID: readCreateID(dependencies.createID),
  });

  return Object.freeze({
    reserve: (input: ReserveUploadInput) => reserve(context, input),
    acquireFinalizationLease: (input: AcquireFinalizationLeaseInput) =>
      acquireFinalizationLease(context, input),
    attachFinalObject: (input: AttachFinalObjectInput) =>
      attachFinalObject(context, input),
    expireReservation: (input: ExpireReservationInput) =>
      expireReservation(context, input),
  });
}

async function reserve(
  context: RepositoryContext,
  rawInput: unknown,
): Promise<ReserveUploadResult> {
  const input = readReserveInput(rawInput);

  try {
    // Read-only idempotent fast path, deliberately before any quota lock or
    // capacity check so a retry at quota-full still returns the reservation.
    const existing = await context.client.upload.findFirst({
      where: { uploadID: input.uploadID, userID: input.userID },
      select: UPLOAD_SELECT,
    });
    if (existing !== null) {
      return replayReservation(existing, input);
    }

    return await context.client.$transaction(
      async (transaction) => {
        // Quota lock first, before project/device/upload work.
        const quota = await lockQuotaForUpdate(transaction, input.userID);

        // A concurrent retry may have committed while this transaction waited.
        const rechecked = await findOwnUpload(
          transaction,
          input.userID,
          input.uploadID,
        );
        if (rechecked !== null) {
          return replayReservation(rechecked, input);
        }

        const now = readNowDate(context);

        await assertActiveDevice(transaction, input, now);
        await assertActiveProject(transaction, input);
        await assertParentRevision(transaction, input);

        const intent = await transaction.upload.findFirst({
          where: {
            userID: input.userID,
            projectID: input.projectID,
            revisionID: input.revisionID,
            state: { in: [...ACTIVE_INTENT_STATES] },
          },
          select: UPLOAD_SELECT,
        });
        if (intent !== null) {
          return replayReservation(intent, input);
        }

        // Only reject a committed revision when no upload record can be reused.
        // A matching ready row above remains the idempotent retry result.
        await assertRevisionNotCommitted(transaction, input);

        assertReservationAllowed(
          quota,
          input.sizeBytesBigInt,
          context.policy.maxCiphertextBytes,
        );

        const stagingKey = stagingKeyFor(
          input.userID,
          input.uploadID,
          context.createID(),
        );
        const expiresAt = addMilliseconds(
          now,
          context.policy.reservationTTLMilliseconds,
        );

        let created: UploadRow;
        try {
          created = await transaction.upload.create({
            data: {
              uploadID: input.uploadID,
              userID: input.userID,
              projectID: input.projectID,
              deviceID: input.deviceID,
              revisionID: input.revisionID,
              parentRevisionID: input.parentRevisionID,
              keyEpoch: input.keyEpoch,
              stagingKey,
              finalKey: null,
              state: 'uploading',
              sizeBytes: input.sizeBytesBigInt,
              ciphertextSha256: new Uint8Array(input.ciphertextSha256),
              leaseToken: 0n,
              leaseOwner: null,
              leaseExpiresAt: null,
              expiresAt,
              graceExpiresAt: null,
              completedAt: null,
            },
            select: UPLOAD_SELECT,
          });
        } catch (error) {
          if (isPrismaUniqueConstraintError(error)) {
            // Either the upload primary key or the active revision-intent
            // partial unique index collided. Do not read a foreign row.
            throw new UploadRepositoryError('upload-conflict');
          }
          throw error;
        }

        await addReservedBytes(transaction, quota, input.sizeBytesBigInt);

        return Object.freeze({
          idempotent: false,
          upload: toUploadDTO(created),
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeUploadError(error);
  }
}

async function acquireFinalizationLease(
  context: RepositoryContext,
  rawInput: unknown,
): Promise<FinalizationLeaseResult> {
  const input = readAcquireLeaseInput(rawInput);

  try {
    return await context.client.$transaction(
      async (transaction) => {
        const row = await lockOwnUpload(
          transaction,
          input.userID,
          input.uploadID,
        );
        const now = readNowDate(context);

        if (row.state === 'ready') {
          return leaseResult('ready', 200, row);
        }
        if (row.state === 'deleting' || row.state === 'deleted') {
          throw new UploadRepositoryError('upload-state-conflict');
        }
        if (row.state === 'expired') {
          throw new UploadRepositoryError('upload-expired');
        }
        if (row.state === 'uploading' && row.expiresAt.getTime() <= now.getTime()) {
          throw new UploadRepositoryError('upload-expired');
        }
        if (
          row.state === 'finalizing' &&
          row.leaseExpiresAt !== null &&
          row.leaseExpiresAt.getTime() > now.getTime()
        ) {
          const remaining = row.leaseExpiresAt.getTime() - now.getTime();
          const result = leaseResult('in-progress', 202, row);
          return Object.freeze({
            ...result,
            retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1_000)),
          });
        }

        const leaseOwner = input.leaseOwner ?? context.createID();
        const nextToken = row.leaseToken + 1n;
        if (nextToken > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new UploadRepositoryError('upload-state-conflict');
        }

        const updated = await transaction.upload.update({
          where: { uploadID: row.uploadID },
          data: {
            state: 'finalizing',
            leaseToken: nextToken,
            leaseOwner,
            leaseExpiresAt: addMilliseconds(
              now,
              context.policy.leaseTTLMilliseconds,
            ),
          },
          select: UPLOAD_SELECT,
        });

        return leaseResult('leased', 200, updated);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeUploadError(error);
  }
}

async function attachFinalObject(
  context: RepositoryContext,
  rawInput: unknown,
): Promise<AttachFinalObjectResult> {
  const input = readAttachInput(rawInput);

  try {
    return await context.client.$transaction(
      async (transaction) => {
        // Quota lock must precede the upload lock for every counter change.
        const quota = await lockQuotaForUpdate(transaction, input.userID);
        const row = await lockOwnUpload(
          transaction,
          input.userID,
          input.uploadID,
        );
        const now = readNowDate(context);

        if (row.state === 'ready') {
          if (
            row.finalKey === input.verifiedFinalKey &&
            metadataMatches(row, input)
          ) {
            return Object.freeze({
              outcome: 'idempotent' as const,
              charged: false,
              upload: toUploadDTO(row),
            });
          }
          // A ready upload may never be re-pointed at a different object.
          throw new UploadRepositoryError('upload-state-conflict');
        }

        if (row.state === 'expired') {
          throw new UploadRepositoryError('upload-expired');
        }
        if (row.state !== 'finalizing') {
          throw new UploadRepositoryError('upload-state-conflict');
        }

        if (
          row.leaseToken !== input.leaseToken ||
          row.leaseOwner !== input.leaseOwner ||
          row.leaseExpiresAt === null ||
          row.leaseExpiresAt.getTime() <= now.getTime()
        ) {
          // Stale finalizer: no charge, no state change. A late S3 copy is an
          // orphan owned by the future janitor.
          return Object.freeze({
            outcome: 'stale' as const,
            charged: false,
            upload: toUploadDTO(row),
          });
        }

        if (!metadataMatches(row, input)) {
          throw new UploadRepositoryError('upload-conflict');
        }

        const expectedFinalKey = finalKeyFor(
          input.userID,
          input.uploadID,
          row.leaseToken,
        );
        if (input.verifiedFinalKey !== expectedFinalKey) {
          // The server-generated key for this lease generation cannot be
          // overwritten by a caller-supplied key.
          throw new UploadRepositoryError('upload-conflict');
        }

        const project = await transaction.project.findFirst({
          where: {
            projectID: row.projectID,
            userID: input.userID,
            state: 'active',
          },
          select: PROJECT_SELECT,
        });
        if (project === null) {
          throw new UploadRepositoryError('upload-state-conflict');
        }

        await moveReservedToUsed(transaction, quota, row.sizeBytes);

        const updated = await transaction.upload.update({
          where: { uploadID: row.uploadID },
          data: {
            state: 'ready',
            finalKey: input.verifiedFinalKey,
            graceExpiresAt: addMilliseconds(
              now,
              context.policy.graceTTLMilliseconds,
            ),
            completedAt: now,
          },
          select: UPLOAD_SELECT,
        });

        return Object.freeze({
          outcome: 'attached' as const,
          charged: true,
          upload: toUploadDTO(updated),
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeUploadError(error);
  }
}

async function expireReservation(
  context: RepositoryContext,
  rawInput: unknown,
): Promise<ExpireReservationResult> {
  const input = readExpireInput(rawInput);

  try {
    return await context.client.$transaction(
      async (transaction) => {
        // Quota lock first because expiry may release reserved bytes.
        const quota = await lockQuotaForUpdate(transaction, input.userID);
        const row = await lockOwnUpload(
          transaction,
          input.userID,
          input.uploadID,
        );
        const now = readNowDate(context);

        if (
          row.state === 'uploading' &&
          row.expiresAt.getTime() <= now.getTime()
        ) {
          const updated = await transaction.upload.update({
            where: { uploadID: row.uploadID },
            data: { state: 'expired' },
            select: UPLOAD_SELECT,
          });
          await releaseReservedBytes(transaction, quota, row.sizeBytes);
          return Object.freeze({
            outcome: 'expired' as const,
            released: true,
            upload: toUploadDTO(updated),
          });
        }

        if (row.state === 'finalizing') {
          if (
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt.getTime() > now.getTime()
          ) {
            return Object.freeze({
              outcome: 'live-lease' as const,
              released: false,
              upload: toUploadDTO(row),
            });
          }

          // Fence first: a stale finalizer with the old token can no longer
          // attach after this transaction commits.
          const fencedToken = row.leaseToken + 1n;
          if (fencedToken > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new UploadRepositoryError('upload-state-conflict');
          }
          await transaction.upload.update({
            where: { uploadID: row.uploadID },
            data: {
              leaseToken: fencedToken,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
            select: { uploadID: true },
          });
          await releaseReservedBytes(transaction, quota, row.sizeBytes);
          const updated = await transaction.upload.update({
            where: { uploadID: row.uploadID },
            data: { state: 'expired' },
            select: UPLOAD_SELECT,
          });

          return Object.freeze({
            outcome: 'expired' as const,
            released: true,
            upload: toUploadDTO(updated),
          });
        }

        if (row.state === 'uploading') {
          return Object.freeze({
            outcome: 'not-expired' as const,
            released: false,
            upload: toUploadDTO(row),
          });
        }

        return Object.freeze({
          outcome: 'terminal' as const,
          released: false,
          upload: toUploadDTO(row),
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeUploadError(error);
  }
}

async function findOwnUpload(
  transaction: UploadTransaction,
  userID: string,
  uploadID: string,
): Promise<UploadRow | null> {
  return transaction.upload.findFirst({
    where: { uploadID, userID },
    select: UPLOAD_SELECT,
  });
}

/**
 * Lock the tenant-scoped upload row. SQL text is static and both identifiers
 * are bound tagged-template parameters; there is no raw/unsafe call.
 */
async function lockOwnUpload(
  transaction: UploadTransaction,
  userID: string,
  uploadID: string,
): Promise<UploadRow> {
  const rows = await transaction.$queryRaw<Array<{ uploadID: string }>>`
    SELECT "uploadID"
    FROM "Upload"
    WHERE "uploadID" = ${uploadID} AND "userID" = ${userID}
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new UploadRepositoryError('upload-not-found');
  }
  if (rows.length !== 1) {
    throw new UploadRepositoryError('repository-unavailable');
  }

  const row = await findOwnUpload(transaction, userID, uploadID);
  if (row === null) {
    throw new UploadRepositoryError('upload-not-found');
  }

  return row;
}

async function assertActiveDevice(
  transaction: UploadTransaction,
  input: NormalizedReserveInput,
  now: Date,
): Promise<void> {
  const device = await transaction.device.findFirst({
    where: { id: input.deviceID, userID: input.userID },
    select: DEVICE_SELECT,
  });

  if (
    device === null ||
    device.userID !== input.userID ||
    device.grant.status !== 'active' ||
    device.grant.expiresAt.getTime() <= now.getTime()
  ) {
    throw new UploadRepositoryError('device-not-authorized');
  }
}

async function assertActiveProject(
  transaction: UploadTransaction,
  input: NormalizedReserveInput,
): Promise<void> {
  const project = await transaction.project.findFirst({
    where: {
      projectID: input.projectID,
      userID: input.userID,
      state: 'active',
    },
    select: PROJECT_SELECT,
  });

  if (project === null) {
    throw new UploadRepositoryError('project-not-found');
  }
}

async function assertParentRevision(
  transaction: UploadTransaction,
  input: NormalizedReserveInput,
): Promise<void> {
  if (input.parentRevisionID === null) {
    return;
  }

  const parent = await transaction.revision.findFirst({
    where: {
      revisionID: input.parentRevisionID,
      projectID: input.projectID,
      userID: input.userID,
    },
    select: REVISION_SELECT,
  });

  if (parent === null) {
    throw new UploadRepositoryError('parent-revision-not-found');
  }
}

async function assertRevisionNotCommitted(
  transaction: UploadTransaction,
  input: NormalizedReserveInput,
): Promise<void> {
  const committed = await transaction.revision.findFirst({
    where: {
      revisionID: input.revisionID,
      projectID: input.projectID,
      userID: input.userID,
    },
    select: REVISION_SELECT,
  });

  if (committed !== null) {
    throw new UploadRepositoryError('revision-already-committed');
  }
}

function replayReservation(
  row: UploadRow,
  input: NormalizedReserveInput,
): ReserveUploadResult {
  if (
    row.userID !== input.userID ||
    row.deviceID !== input.deviceID ||
    row.projectID !== input.projectID ||
    row.revisionID !== input.revisionID ||
    row.parentRevisionID !== input.parentRevisionID ||
    row.keyEpoch !== input.keyEpoch ||
    row.sizeBytes !== input.sizeBytesBigInt ||
    !bytesEqual(row.ciphertextSha256, input.ciphertextSha256)
  ) {
    throw new UploadRepositoryError('upload-conflict');
  }

  return Object.freeze({
    idempotent: true,
    upload: toUploadDTO(row),
  });
}

function leaseResult(
  outcome: 'leased' | 'in-progress' | 'ready',
  statusCode: 200 | 202,
  row: UploadRow,
): FinalizationLeaseResult {
  const allocatedFinalKey =
    row.finalKey ??
    (row.leaseToken > 0n
      ? finalKeyFor(row.userID, row.uploadID, row.leaseToken)
      : null);

  return Object.freeze({
    outcome,
    statusCode,
    upload: toUploadDTO(row),
    leaseToken: row.leaseToken,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt:
      row.leaseExpiresAt === null ? null : row.leaseExpiresAt.toISOString(),
    finalKey: allocatedFinalKey,
  });
}

function metadataMatches(
  row: UploadRow,
  input: NormalizedAttachInput,
): boolean {
  return (
    row.sizeBytes === input.verifiedSizeBytes &&
    bytesEqual(row.ciphertextSha256, input.verifiedCiphertextSha256)
  );
}

function toUploadDTO(row: UploadRow): UploadRecordDTO {
  return Object.freeze({
    uploadID: row.uploadID.toLowerCase(),
    projectID: row.projectID.toLowerCase(),
    deviceID: row.deviceID.toLowerCase(),
    revisionID: row.revisionID.toLowerCase(),
    parentRevisionID:
      row.parentRevisionID === null
        ? null
        : row.parentRevisionID.toLowerCase(),
    keyEpoch: row.keyEpoch,
    state: row.state,
    sizeBytes: row.sizeBytes,
    ciphertextSha256: new Uint8Array(row.ciphertextSha256),
    stagingKey: row.stagingKey,
    finalKey: row.finalKey,
    leaseToken: row.leaseToken,
    leaseOwner: row.leaseOwner,
    expiresAt: row.expiresAt.toISOString(),
    leaseExpiresAt:
      row.leaseExpiresAt === null ? null : row.leaseExpiresAt.toISOString(),
    graceExpiresAt:
      row.graceExpiresAt === null ? null : row.graceExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    completedAt:
      row.completedAt === null ? null : row.completedAt.toISOString(),
  });
}

function stagingKeyFor(
  userID: string,
  uploadID: string,
  nonce: string,
): string {
  // Fixed server namespace; the opaque user ID is base64url encoded rather
  // than used as a path prefix. The nonce is a server UUID.
  return `staging/v1/${encodeKeySegment(userID)}/${uploadID.toLowerCase()}/${nonce.toLowerCase()}`;
}

function finalKeyFor(
  userID: string,
  uploadID: string,
  leaseToken: bigint,
): string {
  return `final/v1/${encodeKeySegment(userID)}/${uploadID.toLowerCase()}/${leaseToken.toString(10)}`;
}

function encodeKeySegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function readPolicy(rawPolicy: unknown): NormalizedPolicy {
  if (
    typeof rawPolicy !== 'object' ||
    rawPolicy === null ||
    Array.isArray(rawPolicy)
  ) {
    throw inputError();
  }

  const policy = rawPolicy as {
    readonly maxCiphertextBytes?: unknown;
    readonly reservationTTLSeconds?: unknown;
    readonly graceTTLSeconds?: unknown;
    readonly leaseTTLSeconds?: unknown;
  };

  const maxCiphertextBytes = readPositiveByteLimit(
    policy.maxCiphertextBytes,
  );
  return Object.freeze({
    maxCiphertextBytes,
    reservationTTLMilliseconds: readTTLMilliseconds(
      policy.reservationTTLSeconds,
    ),
    graceTTLMilliseconds: readTTLMilliseconds(policy.graceTTLSeconds),
    leaseTTLMilliseconds: readTTLMilliseconds(policy.leaseTTLSeconds),
  });
}

function readPositiveByteLimit(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw inputError();
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw inputError();
    }
    return value;
  }
  throw inputError();
}

function readTTLMilliseconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > Math.floor(MAX_SAFE_MILLISECONDS / 1_000)
  ) {
    throw inputError();
  }
  return value * 1_000;
}

function readNow(value: unknown): () => Date {
  if (value === undefined) {
    return () => new Date();
  }
  if (typeof value !== 'function') {
    throw inputError();
  }
  return value as () => Date;
}

function readCreateID(value: unknown): () => string {
  if (value === undefined) {
    return () => randomUUID();
  }
  if (typeof value !== 'function') {
    throw inputError();
  }
  return value as () => string;
}

function readNowDate(context: RepositoryContext): Date {
  const now = context.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new UploadRepositoryError('repository-unavailable');
  }
  return new Date(now.getTime());
}

function addMilliseconds(base: Date, milliseconds: number): Date {
  const value = base.getTime() + milliseconds;
  if (!Number.isSafeInteger(value)) {
    throw new UploadRepositoryError('repository-unavailable');
  }
  return new Date(value);
}

function readReserveInput(rawInput: unknown): NormalizedReserveInput {
  if (
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw inputError();
  }

  const input = rawInput as {
    readonly userID?: unknown;
    readonly deviceID?: unknown;
    readonly projectID?: unknown;
    readonly uploadID?: unknown;
    readonly revisionID?: unknown;
    readonly parentRevisionID?: unknown;
    readonly keyEpoch?: unknown;
    readonly sizeBytes?: unknown;
    readonly ciphertextSha256?: unknown;
  };

  if (input.keyEpoch !== 1) {
    throw inputError();
  }
  if (
    typeof input.sizeBytes !== 'number' ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0
  ) {
    throw inputError();
  }

  return Object.freeze({
    userID: readUserID(input.userID),
    deviceID: readUUID(input.deviceID),
    projectID: readUUID(input.projectID),
    uploadID: readUUID(input.uploadID),
    revisionID: readUUID(input.revisionID),
    parentRevisionID:
      input.parentRevisionID === undefined || input.parentRevisionID === null
        ? null
        : readUUID(input.parentRevisionID),
    keyEpoch: 1 as const,
    sizeBytes: input.sizeBytes,
    sizeBytesBigInt: BigInt(input.sizeBytes),
    ciphertextSha256: readDigest(input.ciphertextSha256),
  });
}

function readAcquireLeaseInput(rawInput: unknown): {
  readonly userID: string;
  readonly uploadID: string;
  readonly leaseOwner: string | null;
} {
  if (
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw inputError();
  }

  const input = rawInput as {
    readonly userID?: unknown;
    readonly uploadID?: unknown;
    readonly leaseOwner?: unknown;
  };

  return Object.freeze({
    userID: readUserID(input.userID),
    uploadID: readUUID(input.uploadID),
    leaseOwner:
      input.leaseOwner === undefined
        ? null
        : readLeaseOwner(input.leaseOwner),
  });
}

function readAttachInput(rawInput: unknown): NormalizedAttachInput {
  if (
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw inputError();
  }

  const input = rawInput as {
    readonly userID?: unknown;
    readonly uploadID?: unknown;
    readonly leaseToken?: unknown;
    readonly leaseOwner?: unknown;
    readonly verifiedStorageObject?: unknown;
  };

  const verified = readVerifiedStorageObject(input.verifiedStorageObject);

  return Object.freeze({
    userID: readUserID(input.userID),
    uploadID: readUUID(input.uploadID),
    leaseToken: readLeaseToken(input.leaseToken),
    leaseOwner: readLeaseOwner(input.leaseOwner),
    verifiedFinalKey: verified.finalKey,
    verifiedSizeBytes: verified.sizeBytes,
    verifiedCiphertextSha256: verified.ciphertextSha256,
  });
}

function readExpireInput(rawInput: unknown): NormalizedExpireInput {
  if (
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw inputError();
  }

  const input = rawInput as {
    readonly userID?: unknown;
    readonly uploadID?: unknown;
  };

  return Object.freeze({
    userID: readUserID(input.userID),
    uploadID: readUUID(input.uploadID),
  });
}

function readVerifiedStorageObject(rawValue: unknown): {
  readonly finalKey: string;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
} {
  if (
    typeof rawValue !== 'object' ||
    rawValue === null ||
    Array.isArray(rawValue)
  ) {
    throw inputError();
  }

  const value = rawValue as {
    readonly finalKey?: unknown;
    readonly sizeBytes?: unknown;
    readonly ciphertextSha256?: unknown;
  };

  if (
    typeof value.finalKey !== 'string' ||
    value.finalKey.length === 0 ||
    value.finalKey.length > MAX_KEY_LENGTH ||
    CONTROL_CHARACTERS.test(value.finalKey)
  ) {
    throw inputError();
  }

  const sizeBytes = readVerifiedSize(value.sizeBytes);
  return Object.freeze({
    finalKey: value.finalKey,
    sizeBytes,
    ciphertextSha256: readDigest(value.ciphertextSha256),
  });
}

function readVerifiedSize(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw inputError();
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw inputError();
    }
    return value;
  }
  throw inputError();
}

function readUserID(value: unknown): string {
  if (typeof value !== 'string') {
    throw inputError();
  }
  if (value.length === 0 || value.length > MAX_USER_ID_LENGTH) {
    throw inputError();
  }
  if (value.trim().length === 0 || CONTROL_CHARACTERS.test(value)) {
    throw inputError();
  }
  return value;
}

function readLeaseOwner(value: unknown): string {
  if (typeof value !== 'string') {
    throw inputError();
  }
  if (
    value.length === 0 ||
    value.length > MAX_LEASE_OWNER_LENGTH ||
    value.trim().length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw inputError();
  }
  return value;
}

function readLeaseToken(value: unknown): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw inputError();
    }
    return value;
  }
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw inputError();
}

function readUUID(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw inputError();
  }
  return value.toLowerCase();
}

function readDigest(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw inputError();
  }
  return new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'P2002'
  );
}

function sanitizeUploadError(error: unknown): UploadRepositoryError {
  if (error instanceof UploadRepositoryError) {
    return error;
  }
  if (error instanceof QuotaAccountingError) {
    return new UploadRepositoryError(QUOTA_ERROR_MAP[error.code]);
  }
  return new UploadRepositoryError('repository-unavailable');
}

function inputError(): UploadRepositoryError {
  return new UploadRepositoryError('invalid-upload-input');
}
