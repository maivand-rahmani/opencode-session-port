/**
 * Tenant-scoped revision DAG commit and event-page repository.
 *
 * This module contains no HTTP, authentication, quota accounting, storage
 * provider, or upload-finalization implementation. The caller supplies an
 * already authorized user/device pair and canonical UUIDs.
 *
 * Commit lock order: Project row, then Upload row. The project row lock
 * serialises sequence allocation, parent-head replacement, and sibling commits
 * for the same project. UserQuota rows are never read or written here.
 *
 * Idempotence compares only server-visible immutable fields. `uploadID` is a
 * transport for the persisted ciphertext fields and is not part of revision
 * identity, so a replacement upload may be used after reservation expiry when
 * the visible fields still match. A ready upload is retained unchanged after
 * commit; this module never deletes a revision, head, upload, or object.
 *
 * A repeated revision ID that exists outside the caller's user/project scope
 * is reported as the same fixed conflict as any other insertion collision;
 * foreign rows are never read into a response.
 */

import type {
  Prisma,
  PrismaClient,
  UploadState,
} from '../../prisma/generated/client/client.js';
import { parseCursor } from '../protocol/cursor.js';
import { RevisionRepositoryError } from './errors.js';

export { RevisionRepositoryError } from './errors.js';
export type { RevisionRepositoryErrorCode } from './errors.js';

const MAX_USER_ID_LENGTH = 1_024;
const MAX_LIMIT_DIGITS = 16;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ASCII_DECIMAL_DIGITS = /^[0-9]+$/;
const CANONICAL_LIMIT = /^(?:0|[1-9][0-9]*)$/;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const EXISTING_REVISION_SELECT = {
  revisionID: true,
  projectID: true,
  userID: true,
  parentRevisionID: true,
  seq: true,
  deviceID: true,
  keyEpoch: true,
  sizeBytes: true,
  ciphertextSha256: true,
  storageObjectKey: true,
} as const;

const REVISION_PAGE_SELECT = {
  revisionID: true,
  parentRevisionID: true,
  seq: true,
  deviceID: true,
  keyEpoch: true,
  sizeBytes: true,
  ciphertextSha256: true,
  createdAt: true,
} as const;

const UPLOAD_SELECT = {
  uploadID: true,
  userID: true,
  projectID: true,
  deviceID: true,
  revisionID: true,
  parentRevisionID: true,
  keyEpoch: true,
  finalKey: true,
  state: true,
  sizeBytes: true,
  ciphertextSha256: true,
} as const;

/**
 * Minimal structural dependency accepted by the production factory. The
 * generated `PrismaClient` is assignable to this pick; tests can provide a
 * small fake without a mock framework.
 */
export type RevisionRepositoryClient = Pick<
  PrismaClient,
  '$transaction' | 'project' | 'revision' | 'projectHead' | 'upload' | 'device'
>;

type RevisionTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'project' | 'revision' | 'projectHead' | 'upload' | 'device'
>;

export interface RevisionRepositoryOptions {
  /** Explicit, required, positive safe integer. No product default. */
  readonly maxPageSize: number;
  /** Optional clock seam. The database default remains the createdAt source. */
  readonly now?: () => Date;
}

export interface CommitRevisionInput {
  /** Server-verified vendor user identifier. Never supplied by a request body. */
  readonly userID: string;
  /** Server-verified device identifier from the active native grant. */
  readonly deviceID: string;
  readonly projectID: string;
  readonly revisionID: string;
  readonly uploadID: string;
  readonly parentRevisionID: string | null;
}

export interface CommitRevisionResult {
  /** 201 for a new revision, 200 for an idempotent replay. */
  readonly statusCode: 201 | 200;
  readonly revisionID: string;
  /** Decimal string; never a JSON number or BigInt. */
  readonly seq: string;
  /** Current project heads, lexicographically sorted and lowercased. */
  readonly headIDs: readonly string[];
  /** True when the declared parent was no longer a head at commit time. */
  readonly conflict: boolean;
}

export interface RevisionPageInput {
  readonly userID: string;
  readonly projectID: string;
  /** Raw decimal position string. Leading zeros are accepted. */
  readonly after: string;
  /** Raw decimal anchor string. Omitted means the current project maximum. */
  readonly upperBound?: string;
  /** Raw canonical non-negative integer string. `"0"` is valid. */
  readonly limit: string;
}

export interface RevisionDTO {
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  /** Decimal string; never a JSON number or BigInt. */
  readonly seq: string;
  readonly deviceID: string;
  readonly keyEpoch: number;
  /** Safe JSON number; larger stored values become a fixed internal error. */
  readonly sizeBytes: number;
  readonly ciphertextSha256: string;
  readonly createdAt: string;
}

export interface RevisionPage {
  /** Normalised decimal anchor string. */
  readonly upperBound: string;
  readonly nextAfter: string | null;
  readonly hasMore: boolean;
  /** Live head set, not frozen to the event anchor. */
  readonly currentHeadIDs: readonly string[];
  readonly revisions: readonly RevisionDTO[];
}

export interface RevisionRepository {
  commit(input: CommitRevisionInput): Promise<CommitRevisionResult>;
  page(input: RevisionPageInput): Promise<RevisionPage>;
}

interface ProjectLockRow {
  readonly projectID: string;
  readonly userID: string;
  readonly nextSeq: bigint;
}

interface UploadLockRow {
  readonly uploadID: string;
  readonly userID: string;
  readonly projectID: string;
  readonly deviceID: string;
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly keyEpoch: number;
  readonly finalKey: string | null;
  readonly state: UploadState;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
}

interface ExistingRevisionRow {
  readonly revisionID: string;
  readonly projectID: string;
  readonly userID: string;
  readonly parentRevisionID: string | null;
  readonly seq: bigint;
  readonly deviceID: string;
  readonly keyEpoch: number;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
  readonly storageObjectKey: string;
}

interface UploadRow {
  readonly uploadID: string;
  readonly userID: string;
  readonly projectID: string;
  readonly deviceID: string;
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly keyEpoch: number;
  readonly finalKey: string | null;
  readonly state: UploadState;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
}

interface RevisionPageRow {
  readonly revisionID: string;
  readonly parentRevisionID: string | null;
  readonly seq: bigint;
  readonly deviceID: string;
  readonly keyEpoch: number;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
  readonly createdAt: Date;
}

interface ValidatedCommitInput {
  readonly userID: string;
  readonly deviceID: string;
  readonly projectID: string;
  readonly revisionID: string;
  readonly uploadID: string;
  readonly parentRevisionID: string | null;
}

interface ValidatedPageInput {
  readonly userID: string;
  readonly projectID: string;
  readonly after: string;
  readonly upperBound?: string;
  readonly limit: number;
}

/**
 * Build the repository. Options are validated before the client is captured or
 * used. A missing or invalid `maxPageSize` fails closed; there is no default.
 */
export function createRevisionRepository(
  client: RevisionRepositoryClient,
  options: RevisionRepositoryOptions,
): RevisionRepository {
  const maxPageSize = readMaxPageSize(options);
  readNowOption(options);

  return Object.freeze({
    commit: (input: CommitRevisionInput) => commit(client, input),
    page: (input: RevisionPageInput) => page(client, maxPageSize, input),
  });
}

async function commit(
  client: RevisionRepositoryClient,
  rawInput: unknown,
): Promise<CommitRevisionResult> {
  const input = readCommitInput(rawInput);

  try {
    return await client.$transaction(
      async (transaction) => {
        const project = await lockProject(
          transaction,
          input.userID,
          input.projectID,
        );

        const existing = await findOwnRevision(transaction, input);
        if (existing !== null) {
          return replayExisting(transaction, existing, input);
        }

        await requireOwnDevice(transaction, input);
        const upload = await lockReadyUpload(transaction, input);
        const uploadFields = validateReadyUpload(upload, input);
        await validateParent(transaction, input);

        return insertCommit(transaction, project, uploadFields, input);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeRepositoryError(error);
  }
}

async function page(
  client: RevisionRepositoryClient,
  maxPageSize: number,
  rawInput: unknown,
): Promise<RevisionPage> {
  const input = readPageInput(rawInput, maxPageSize);

  try {
    return await client.$transaction(
      async (transaction) => {
        const project = await transaction.project.findFirst({
          where: {
            projectID: input.projectID,
            userID: input.userID,
            state: 'active',
          },
          select: { nextSeq: true },
        });
        if (project === null) {
          throw new RevisionRepositoryError('project-not-found');
        }

        const nextSeq = readBigInt(project.nextSeq);
        if (nextSeq < 1n) {
          throw new RevisionRepositoryError('internal-error');
        }
        const maximum = nextSeq - 1n;

        let anchor = maximum;
        if (input.upperBound !== undefined) {
          const parsedBound = parseCursor(input.upperBound, maximum);
          if (!parsedBound.ok) {
            throw new RevisionRepositoryError('invalid-cursor');
          }
          anchor = parsedBound.value;
        }

        const parsedAfter = parseCursor(input.after, anchor);
        if (!parsedAfter.ok) {
          throw new RevisionRepositoryError('invalid-cursor');
        }

        const where = {
          projectID: input.projectID,
          userID: input.userID,
          seq: { gt: parsedAfter.value, lte: anchor },
        };

        let pageRows: RevisionPageRow[];
        let hasMore: boolean;

        if (input.limit === 0) {
          const existing = await transaction.revision.findFirst({
            where,
            select: { revisionID: true },
          });
          pageRows = [];
          hasMore = existing !== null;
        } else {
          const rows = await transaction.revision.findMany({
            where,
            orderBy: { seq: 'asc' },
            take: input.limit + 1,
            select: REVISION_PAGE_SELECT,
          });
          pageRows = rows.slice(0, input.limit);
          hasMore = rows.length > input.limit;
        }

        // Live read, intentionally not frozen to the event anchor. Readers
        // must not treat this as a per-anchor head snapshot.
        const currentHeadIDs = await readHeadIDs(
          transaction,
          input.projectID,
        );

        const revisions = Object.freeze(
          pageRows.map((row) => toRevisionDTO(row)),
        );
        const nextAfter =
          pageRows.length === 0
            ? null
            : readBigInt(pageRows[pageRows.length - 1]!.seq).toString();

        return Object.freeze({
          upperBound: anchor.toString(),
          nextAfter,
          hasMore,
          currentHeadIDs,
          revisions,
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeRepositoryError(error);
  }
}

async function lockProject(
  transaction: RevisionTransaction,
  userID: string,
  projectID: string,
): Promise<ProjectLockRow> {
  const rows = await transaction.$queryRaw<ProjectLockRow[]>`
    SELECT "projectID", "userID", "nextSeq"
    FROM "Project"
    WHERE "projectID" = ${projectID}
      AND "userID" = ${userID}
      AND "state" = 'active'
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    // Missing, foreign-owned, and purged projects are indistinguishable.
    throw new RevisionRepositoryError('project-not-found');
  }

  const row = rows[0]!;
  if (row.userID !== userID || row.projectID.toLowerCase() !== projectID) {
    throw new RevisionRepositoryError('project-not-found');
  }

  const nextSeq = readBigInt(row.nextSeq);
  if (nextSeq < 1n) {
    throw new RevisionRepositoryError('internal-error');
  }

  return row;
}

async function findOwnRevision(
  transaction: RevisionTransaction,
  input: ValidatedCommitInput,
): Promise<ExistingRevisionRow | null> {
  return transaction.revision.findFirst({
    where: {
      revisionID: input.revisionID,
      userID: input.userID,
      projectID: input.projectID,
    },
    select: EXISTING_REVISION_SELECT,
  });
}

/**
 * A repeated revision ID returns the persisted result without touching the
 * sequence, head set, quota, or upload rows. The caller may supply a
 * replacement upload ID; the original committed upload remains the fallback
 * when the replacement reservation is missing or no longer ready.
 */
async function replayExisting(
  transaction: RevisionTransaction,
  existing: ExistingRevisionRow,
  input: ValidatedCommitInput,
): Promise<CommitRevisionResult> {
  if (
    existing.revisionID !== input.revisionID ||
    existing.userID !== input.userID ||
    existing.projectID !== input.projectID ||
    existing.parentRevisionID !== input.parentRevisionID ||
    existing.deviceID !== input.deviceID
  ) {
    throw new RevisionRepositoryError('revision-conflict');
  }

  const provided = await transaction.upload.findFirst({
    where: {
      uploadID: input.uploadID,
      userID: input.userID,
      projectID: input.projectID,
      deviceID: input.deviceID,
    },
    select: UPLOAD_SELECT,
  });

  if (provided !== null && provided.state === 'ready') {
    if (!uploadMatchesRevision(provided, existing)) {
      throw new RevisionRepositoryError('revision-conflict');
    }
    return replayResult(transaction, input.projectID, existing);
  }

  // The supplied reservation may have expired or been replaced. The original
  // committed upload is still linked through the revision's final key.
  const original = await transaction.upload.findFirst({
    where: {
      finalKey: existing.storageObjectKey,
      userID: input.userID,
      projectID: input.projectID,
    },
    select: UPLOAD_SELECT,
  });

  if (
    original === null ||
    !uploadMatchesRevision(original, existing) ||
    original.deviceID !== existing.deviceID
  ) {
    throw new RevisionRepositoryError('upload-not-ready');
  }

  return replayResult(transaction, input.projectID, existing);
}

async function replayResult(
  transaction: RevisionTransaction,
  projectID: string,
  existing: ExistingRevisionRow,
): Promise<CommitRevisionResult> {
  const headIDs = await readHeadIDs(transaction, projectID);

  return Object.freeze({
    statusCode: 200 as const,
    revisionID: existing.revisionID.toLowerCase(),
    seq: readBigInt(existing.seq).toString(),
    headIDs,
    conflict: false,
  });
}

async function requireOwnDevice(
  transaction: RevisionTransaction,
  input: ValidatedCommitInput,
): Promise<void> {
  const device = await transaction.device.findFirst({
    where: { id: input.deviceID, userID: input.userID },
    select: { id: true },
  });
  if (device === null) {
    // Authentication remains authoritative per request; this is only a
    // tenant-consistency check.
    throw new RevisionRepositoryError('device-not-found');
  }
}

async function lockReadyUpload(
  transaction: RevisionTransaction,
  input: ValidatedCommitInput,
): Promise<UploadLockRow> {
  const rows = await transaction.$queryRaw<UploadLockRow[]>`
    SELECT "uploadID", "userID", "projectID", "deviceID", "revisionID",
           "parentRevisionID", "keyEpoch", "finalKey", "state", "sizeBytes",
           "ciphertextSha256"
    FROM "Upload"
    WHERE "uploadID" = ${input.uploadID}
      AND "userID" = ${input.userID}
      AND "projectID" = ${input.projectID}
      AND "deviceID" = ${input.deviceID}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    // Missing, foreign-owned, or mismatched-device uploads are not disclosed.
    throw new RevisionRepositoryError('upload-not-ready');
  }

  return rows[0]!;
}

interface ReadyUploadFields {
  readonly finalKey: string;
  readonly keyEpoch: number;
  readonly sizeBytes: bigint;
  readonly ciphertextSha256: Uint8Array;
}

function validateReadyUpload(
  upload: UploadLockRow,
  input: ValidatedCommitInput,
): ReadyUploadFields {
  if (
    upload.userID !== input.userID ||
    upload.projectID !== input.projectID ||
    upload.deviceID !== input.deviceID
  ) {
    throw new RevisionRepositoryError('upload-not-ready');
  }
  if (upload.state !== 'ready') {
    throw new RevisionRepositoryError('upload-not-ready');
  }
  if (upload.revisionID !== input.revisionID) {
    throw new RevisionRepositoryError('upload-not-ready');
  }
  if (upload.parentRevisionID !== input.parentRevisionID) {
    throw new RevisionRepositoryError('upload-not-ready');
  }

  const finalKey = upload.finalKey;
  if (typeof finalKey !== 'string' || finalKey.length === 0) {
    throw new RevisionRepositoryError('upload-not-ready');
  }

  const keyEpoch = upload.keyEpoch;
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch <= 0) {
    throw new RevisionRepositoryError('upload-not-ready');
  }

  const sizeBytes = readPositiveBigInt(upload.sizeBytes);
  const digest = readDigest(upload.ciphertextSha256);

  return Object.freeze({
    finalKey,
    keyEpoch,
    sizeBytes,
    ciphertextSha256: digest,
  });
}

async function validateParent(
  transaction: RevisionTransaction,
  input: ValidatedCommitInput,
): Promise<void> {
  if (input.parentRevisionID === null) {
    const history = await transaction.revision.findFirst({
      where: { projectID: input.projectID, userID: input.userID },
      select: { revisionID: true },
    });
    if (history !== null) {
      throw new RevisionRepositoryError('parent-required');
    }
    return;
  }

  const parent = await transaction.revision.findFirst({
    where: {
      revisionID: input.parentRevisionID,
      projectID: input.projectID,
      userID: input.userID,
    },
    select: { revisionID: true },
  });
  if (parent === null) {
    throw new RevisionRepositoryError('unknown-parent');
  }
}

async function insertCommit(
  transaction: RevisionTransaction,
  project: ProjectLockRow,
  upload: ReadyUploadFields,
  input: ValidatedCommitInput,
): Promise<CommitRevisionResult> {
  const seq = readBigInt(project.nextSeq);

  try {
    await transaction.revision.create({
      data: {
        revisionID: input.revisionID,
        projectID: input.projectID,
        userID: input.userID,
        parentRevisionID: input.parentRevisionID,
        seq,
        deviceID: input.deviceID,
        keyEpoch: upload.keyEpoch,
        sizeBytes: upload.sizeBytes,
        ciphertextSha256: new Uint8Array(upload.ciphertextSha256),
        storageObjectKey: upload.finalKey,
      },
      select: { revisionID: true },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      // This includes a revision ID owned by another tenant/project. No
      // foreign row is fetched or described.
      throw new RevisionRepositoryError('revision-conflict');
    }
    throw error;
  }

  await transaction.project.update({
    where: { projectID: input.projectID },
    data: { nextSeq: { increment: 1n } },
  });

  let conflict = false;
  if (input.parentRevisionID !== null) {
    const deleted = await transaction.projectHead.deleteMany({
      where: {
        projectID: input.projectID,
        revisionID: input.parentRevisionID,
      },
    });
    // Removing the declared parent only; sibling heads are preserved.
    conflict = deleted.count === 0;
  }

  try {
    await transaction.projectHead.create({
      data: {
        projectID: input.projectID,
        revisionID: input.revisionID,
      },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      throw new RevisionRepositoryError('revision-conflict');
    }
    throw error;
  }

  const headIDs = await readHeadIDs(transaction, input.projectID);

  return Object.freeze({
    statusCode: 201 as const,
    revisionID: input.revisionID,
    seq: seq.toString(),
    headIDs,
    conflict,
  });
}

async function readHeadIDs(
  transaction: RevisionTransaction,
  projectID: string,
): Promise<readonly string[]> {
  const rows = await transaction.projectHead.findMany({
    where: { projectID },
    select: { revisionID: true },
  });

  return Object.freeze(
    rows.map((row) => row.revisionID.toLowerCase()).sort(),
  );
}

function uploadMatchesRevision(
  upload: UploadRow,
  revision: ExistingRevisionRow,
): boolean {
  try {
    return (
      upload.state === 'ready' &&
      upload.userID === revision.userID &&
      upload.projectID === revision.projectID &&
      upload.revisionID === revision.revisionID &&
      upload.parentRevisionID === revision.parentRevisionID &&
      upload.deviceID === revision.deviceID &&
      upload.keyEpoch === revision.keyEpoch &&
      readBigInt(upload.sizeBytes) === readBigInt(revision.sizeBytes) &&
      bytesEqual(upload.ciphertextSha256, revision.ciphertextSha256)
    );
  } catch {
    return false;
  }
}

function toRevisionDTO(row: RevisionPageRow): RevisionDTO {
  const seq = readBigInt(row.seq);
  const sizeBytes = readBigInt(row.sizeBytes);
  if (sizeBytes <= 0n || sizeBytes > MAX_SAFE_BIGINT) {
    // The wire contract permits only safe JSON numbers for size here.
    throw new RevisionRepositoryError('internal-error');
  }

  const keyEpoch = row.keyEpoch;
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch <= 0) {
    throw new RevisionRepositoryError('internal-error');
  }

  if (!(row.createdAt instanceof Date)) {
    throw new RevisionRepositoryError('internal-error');
  }

  return Object.freeze({
    revisionID: row.revisionID.toLowerCase(),
    parentRevisionID:
      row.parentRevisionID === null
        ? null
        : row.parentRevisionID.toLowerCase(),
    seq: seq.toString(),
    deviceID: row.deviceID.toLowerCase(),
    keyEpoch,
    sizeBytes: Number(sizeBytes),
    ciphertextSha256: Buffer.from(
      readStoredDigest(row.ciphertextSha256),
    ).toString('base64'),
    createdAt: row.createdAt.toISOString(),
  });
}

function readMaxPageSize(options: unknown): number {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw inputError();
  }

  const value = (options as { readonly maxPageSize?: unknown }).maxPageSize;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw inputError();
  }

  return value;
}

function readNowOption(options: unknown): (() => Date) | undefined {
  const value = (options as { readonly now?: unknown }).now;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw inputError();
  }

  return value as () => Date;
}

function readCommitInput(rawInput: unknown): ValidatedCommitInput {
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
    readonly revisionID?: unknown;
    readonly uploadID?: unknown;
    readonly parentRevisionID?: unknown;
  };

  return {
    userID: readUserID(input.userID),
    deviceID: readUUID(input.deviceID),
    projectID: readUUID(input.projectID),
    revisionID: readUUID(input.revisionID),
    uploadID: readUUID(input.uploadID),
    parentRevisionID:
      input.parentRevisionID === null
        ? null
        : readUUID(input.parentRevisionID),
  };
}

function readPageInput(
  rawInput: unknown,
  maxPageSize: number,
): ValidatedPageInput {
  if (
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput)
  ) {
    throw inputError();
  }

  const input = rawInput as {
    readonly userID?: unknown;
    readonly projectID?: unknown;
    readonly after?: unknown;
    readonly upperBound?: unknown;
    readonly limit?: unknown;
  };

  const userID = readUserID(input.userID);
  const projectID = readUUID(input.projectID);

  if (
    typeof input.after !== 'string' ||
    !ASCII_DECIMAL_DIGITS.test(input.after)
  ) {
    throw new RevisionRepositoryError('invalid-cursor');
  }

  let upperBound: string | undefined;
  if (input.upperBound !== undefined) {
    if (
      typeof input.upperBound !== 'string' ||
      !ASCII_DECIMAL_DIGITS.test(input.upperBound)
    ) {
      throw new RevisionRepositoryError('invalid-cursor');
    }
    upperBound = input.upperBound;
  }

  if (
    typeof input.limit !== 'string' ||
    !CANONICAL_LIMIT.test(input.limit) ||
    input.limit.length > MAX_LIMIT_DIGITS
  ) {
    throw new RevisionRepositoryError('invalid-page-limit');
  }

  const limitValue = BigInt(input.limit);
  if (limitValue > BigInt(maxPageSize)) {
    throw new RevisionRepositoryError('invalid-page-limit');
  }

  return {
    userID,
    projectID,
    after: input.after,
    ...(upperBound === undefined ? {} : { upperBound }),
    limit: Number(limitValue),
  };
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

function readUUID(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw inputError();
  }

  return value.toLowerCase();
}

function readBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new RevisionRepositoryError('internal-error');
}

function readPositiveBigInt(value: unknown): bigint {
  const parsed = readBigInt(value);
  if (parsed <= 0n) {
    throw new RevisionRepositoryError('upload-not-ready');
  }
  return parsed;
}

function readDigest(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RevisionRepositoryError('upload-not-ready');
  }

  return new Uint8Array(value);
}

function readStoredDigest(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new RevisionRepositoryError('internal-error');
  }

  return new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'P2002'
  );
}

function sanitizeRepositoryError(error: unknown): RevisionRepositoryError {
  if (error instanceof RevisionRepositoryError) {
    return error;
  }
  return new RevisionRepositoryError('repository-unavailable');
}

function inputError(): RevisionRepositoryError {
  return new RevisionRepositoryError('invalid-revision-input');
}
