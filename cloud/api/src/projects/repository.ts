/**
 * Tenant-scoped project create/link and list repository.
 *
 * This module deliberately contains no HTTP, authentication, quota
 * provisioning, or purge implementation. Callers must supply an already
 * authenticated vendor `userID`, a client-chosen canonical UUID `projectID`,
 * and an explicit positive active-project cap. There is no product default.
 *
 * Create/link transaction order:
 *   1. Look up the caller's own project by `(projectID, userID)`.
 *   2. If present and active, return the existing row unchanged (idempotent
 *      link, 200). A purged row is a conflict.
 *   3. Otherwise lock the caller's `UserQuota` row with a tagged, parameterised
 *      `SELECT ... FOR UPDATE`; a missing row fails closed.
 *   4. Recheck the caller's project to cover a retry that waited behind another
 *      create.
 *   5. Count the caller's active projects under the quota lock, enforce the
 *      explicit cap, and insert with the trusted caller `userID`.
 *
 * The transaction uses `ReadCommitted`. The quota-row lock serialises creates
 * for the same user, which is sufficient for the cap check. This repository
 * does not add retry loops, raise the isolation level, create quota rows, or
 * assign implicit limits.
 *
 * A primary-key collision on `projectID` is a global UUID collision. The
 * repository performs no foreign-owner lookup or metadata read and returns the
 * fixed `project-id-unavailable` conflict instead.
 */

import type { Prisma, PrismaClient } from '../../prisma/generated/client/client.js';

/**
 * Input guard, not a product quota or a vendor-ID contract. Vendor user IDs
 * remain opaque and are never UUID-coerced, trimmed, or otherwise rewritten.
 */
const MAX_USER_ID_LENGTH = 1_024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const PROJECT_SELECT = {
  projectID: true,
  encryptedLabel: true,
  state: true,
  createdAt: true,
} as const;

const PROJECT_LIST_SELECT = {
  projectID: true,
  encryptedLabel: true,
  createdAt: true,
} as const;

// Actual head rows and relation counts, not synthesised placeholders.
const PROJECT_STATE_SELECT = {
  projectID: true,
  encryptedLabel: true,
  createdAt: true,
  _count: { select: { revisions: true } },
  heads: {
    select: { revisionID: true },
    orderBy: { revisionID: 'asc' },
  },
} as const;

export type ProjectRepositoryErrorCode =
  | 'invalid-project-input'
  | 'active-project-limit-reached'
  | 'quota-not-provisioned'
  | 'project-id-unavailable'
  | 'project-purged'
  | 'repository-unavailable';

interface ProjectRepositoryErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

// Fixed, public-safe messages. No user/project IDs, tokens, labels, SQL, or
// driver text may be added here.
const ERROR_DEFINITIONS: Readonly<
  Record<ProjectRepositoryErrorCode, ProjectRepositoryErrorDefinition>
> = {
  'invalid-project-input': {
    statusCode: 422,
    retryable: false,
    message: 'Project repository input is invalid.',
  },
  'active-project-limit-reached': {
    statusCode: 409,
    retryable: false,
    message: 'The active project limit has been reached.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  'project-id-unavailable': {
    statusCode: 409,
    retryable: false,
    message: 'The project identifier is unavailable.',
  },
  'project-purged': {
    statusCode: 409,
    retryable: false,
    message: 'The project is not active.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The project repository is temporarily unavailable.',
  },
};

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: ProjectRepositoryErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'ProjectRepositoryError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

/**
 * Minimal structural dependency accepted by the production factory. The
 * generated `PrismaClient` is assignable to this pick; tests can provide a
 * small fake without a mock framework.
 */
export type ProjectRepositoryClient = Pick<
  PrismaClient,
  '$transaction' | 'project'
>;

export interface ProjectRepositoryOptions {
  /** Explicit, required, positive safe integer. No product default. */
  readonly maxActiveProjects: number;
}

export interface CreateOrLinkInput {
  /** Vendor-owned opaque user identifier. Never UUID-coerced. */
  readonly userID: string;
  /** Canonical UUID chosen by the client at creation. */
  readonly projectID: string;
  /** Optional client-side encrypted label bytes. Never plaintext metadata. */
  readonly encryptedLabel?: Uint8Array;
}

export interface ListActiveInput {
  readonly userID: string;
}

/**
 * Immutable project view. `createdAt` is an ISO-8601 UTC string chosen
 * explicitly so the repository never exposes a mutable `Date`. No head IDs or
 * revision counts are synthesised by this layer.
 */
export interface ProjectDTO {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
  readonly createdAt: string;
}

export interface CreateOrLinkResult {
  readonly outcome: 'created' | 'linked';
  /** 201 for a new row, 200 for an idempotent existing-owner link. */
  readonly statusCode: 201 | 200;
  readonly project: ProjectDTO;
}

/**
 * Project list view with actual persisted state. `headIDs` and
 * `revisionCount` are read from ProjectHead/Revision; this layer never invents
 * a zero placeholder. The older `ProjectDTO` list contract is unchanged.
 */
export interface ProjectStateDTO {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
  readonly createdAt: string;
  readonly headIDs: readonly string[];
  readonly revisionCount: number;
}

export interface ListWithStateInput {
  readonly userID: string;
}

export interface ProjectRepository {
  createOrLink(input: CreateOrLinkInput): Promise<CreateOrLinkResult>;
  listActive(input: ListActiveInput): Promise<readonly ProjectDTO[]>;
  /**
   * State-enriched list used by `GET /v1/projects`. Optional so legacy
   * create/link-only repositories keep the original dependency contract.
   */
  listWithState?(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]>;
}

/**
 * Production repository shape. The factory always provides the state-enriched
 * list even though the legacy interface keeps it optional for backcompat.
 */
export interface ProjectRepositoryWithState extends ProjectRepository {
  listWithState(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]>;
}

interface ProjectRow {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
  readonly state: 'active' | 'purged';
  readonly createdAt: Date;
}

interface ProjectListRow {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
  readonly createdAt: Date;
}

interface ProjectStateRow {
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
  readonly createdAt: Date;
  readonly _count: { readonly revisions: number };
  readonly heads: readonly { readonly revisionID: string }[];
}

interface QuotaLockRow {
  readonly userID: string;
}

interface ValidatedCreateOrLinkInput {
  readonly userID: string;
  readonly projectID: string;
  readonly encryptedLabel: Uint8Array | null;
}

type ProjectTransaction = Pick<
  Prisma.TransactionClient,
  'project' | '$queryRaw'
>;

/**
 * Build the repository. `maxActiveProjects` is validated before the client is
 * captured or used.
 */
export function createProjectRepository(
  client: ProjectRepositoryClient,
  options: ProjectRepositoryOptions,
): ProjectRepositoryWithState {
  const maxActiveProjects = readMaxActiveProjects(options);

  return Object.freeze({
    createOrLink: (input: CreateOrLinkInput) =>
      createOrLink(client, maxActiveProjects, input),
    listActive: (input: ListActiveInput) => listActive(client, input),
    listWithState: (input: ListWithStateInput) =>
      listWithState(client, input),
  });
}

async function createOrLink(
  client: ProjectRepositoryClient,
  maxActiveProjects: number,
  rawInput: unknown,
): Promise<CreateOrLinkResult> {
  const input = readCreateOrLinkInput(rawInput);

  try {
    return await client.$transaction(
      async (transaction) => {
        const existing = await findOwnProject(
          transaction,
          input.userID,
          input.projectID,
        );
        if (existing !== null) {
          return linkedResult(existing);
        }

        await lockQuotaRow(transaction, input.userID);

        // A concurrent create for the same user may have committed while this
        // transaction waited for the quota lock. Link that row idempotently
        // instead of attempting a duplicate insert.
        const rechecked = await findOwnProject(
          transaction,
          input.userID,
          input.projectID,
        );
        if (rechecked !== null) {
          return linkedResult(rechecked);
        }

        const activeCount = await transaction.project.count({
          where: { userID: input.userID, state: 'active' },
        });
        if (activeCount >= maxActiveProjects) {
          throw new ProjectRepositoryError('active-project-limit-reached');
        }

        const created = await insertProject(transaction, input);
        return Object.freeze({
          outcome: 'created' as const,
          statusCode: 201 as const,
          project: toProjectDTO(created),
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
  } catch (error) {
    throw sanitizeRepositoryError(error);
  }
}

async function listActive(
  client: ProjectRepositoryClient,
  rawInput: unknown,
): Promise<readonly ProjectDTO[]> {
  const input = readListActiveInput(rawInput);

  try {
    const rows = await client.project.findMany({
      where: { userID: input.userID, state: 'active' },
      orderBy: { projectID: 'asc' },
      select: PROJECT_LIST_SELECT,
    });

    return Object.freeze(rows.map(toProjectDTO));
  } catch (error) {
    throw sanitizeRepositoryError(error);
  }
}

/**
 * List the caller's active projects with actual head rows and revision
 * counts. This is a separate method so the existing `listActive` DTO contract
 * remains byte-compatible for current consumers and tests.
 */
async function listWithState(
  client: ProjectRepositoryClient,
  rawInput: unknown,
): Promise<readonly ProjectStateDTO[]> {
  const input = readListActiveInput(rawInput);

  try {
    const rows = await client.project.findMany({
      where: { userID: input.userID, state: 'active' },
      orderBy: { projectID: 'asc' },
      select: PROJECT_STATE_SELECT,
    });

    return Object.freeze(rows.map(toProjectStateDTO));
  } catch (error) {
    throw sanitizeRepositoryError(error);
  }
}

async function findOwnProject(
  transaction: ProjectTransaction,
  userID: string,
  projectID: string,
): Promise<ProjectRow | null> {
  return transaction.project.findFirst({
    where: { projectID, userID },
    select: PROJECT_SELECT,
  });
}

/**
 * Lock the tenant's quota row. The SQL text is static; `userID` is a bound
 * tagged-template parameter. There is no raw/unsafe call.
 */
async function lockQuotaRow(
  transaction: ProjectTransaction,
  userID: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<QuotaLockRow[]>`
    SELECT "userID"
    FROM "UserQuota"
    WHERE "userID" = ${userID}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    throw new ProjectRepositoryError('quota-not-provisioned');
  }
}

async function insertProject(
  transaction: ProjectTransaction,
  input: ValidatedCreateOrLinkInput,
): Promise<ProjectRow> {
  try {
    return await transaction.project.create({
      data: {
        projectID: input.projectID,
        userID: input.userID,
        encryptedLabel:
          input.encryptedLabel === null
            ? null
            : new Uint8Array(input.encryptedLabel),
        state: 'active',
      },
      select: PROJECT_SELECT,
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      // projectID is the Project primary key. Do not fetch or describe the
      // foreign row; the caller only learns that this UUID is unavailable.
      throw new ProjectRepositoryError('project-id-unavailable');
    }
    throw error;
  }
}

function linkedResult(row: ProjectRow): CreateOrLinkResult {
  if (row.state !== 'active') {
    throw new ProjectRepositoryError('project-purged');
  }

  return Object.freeze({
    outcome: 'linked' as const,
    statusCode: 200 as const,
    project: toProjectDTO(row),
  });
}

function toProjectDTO(row: ProjectListRow): ProjectDTO {
  return Object.freeze({
    projectID: row.projectID.toLowerCase(),
    encryptedLabel:
      row.encryptedLabel === null ? null : new Uint8Array(row.encryptedLabel),
    createdAt: row.createdAt.toISOString(),
  });
}

function toProjectStateDTO(row: ProjectStateRow): ProjectStateDTO {
  const revisionCount = row._count.revisions;
  if (!Number.isSafeInteger(revisionCount) || revisionCount < 0) {
    throw new ProjectRepositoryError('repository-unavailable');
  }

  return Object.freeze({
    projectID: row.projectID.toLowerCase(),
    encryptedLabel:
      row.encryptedLabel === null ? null : new Uint8Array(row.encryptedLabel),
    createdAt: row.createdAt.toISOString(),
    headIDs: Object.freeze(
      row.heads.map((head) => head.revisionID.toLowerCase()).sort(),
    ),
    revisionCount,
  });
}

function readMaxActiveProjects(options: unknown): number {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw inputError();
  }

  const value = (options as { maxActiveProjects?: unknown }).maxActiveProjects;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw inputError();
  }

  return value;
}

function readCreateOrLinkInput(
  rawInput: unknown,
): ValidatedCreateOrLinkInput {
  try {
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
      readonly encryptedLabel?: unknown;
    };

    return {
      userID: readUserID(input.userID),
      projectID: readProjectID(input.projectID),
      encryptedLabel: readEncryptedLabel(input.encryptedLabel),
    };
  } catch (error) {
    if (error instanceof ProjectRepositoryError) {
      throw error;
    }
    throw inputError();
  }
}

function readListActiveInput(rawInput: unknown): ListActiveInput {
  try {
    if (
      typeof rawInput !== 'object' ||
      rawInput === null ||
      Array.isArray(rawInput)
    ) {
      throw inputError();
    }

    const input = rawInput as { readonly userID?: unknown };
    return { userID: readUserID(input.userID) };
  } catch (error) {
    if (error instanceof ProjectRepositoryError) {
      throw error;
    }
    throw inputError();
  }
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

function readProjectID(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw inputError();
  }

  // PostgreSQL uuid values are canonically lowercase. Normalise the textual
  // form so the same UUID always reaches queries and DTOs identically.
  return value.toLowerCase();
}

function readEncryptedLabel(value: unknown): Uint8Array | null {
  if (value === undefined) {
    return null;
  }
  if (!(value instanceof Uint8Array)) {
    throw inputError();
  }

  return new Uint8Array(value);
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'P2002'
  );
}

function sanitizeRepositoryError(error: unknown): ProjectRepositoryError {
  if (error instanceof ProjectRepositoryError) {
    return error;
  }
  return new ProjectRepositoryError('repository-unavailable');
}

function inputError(): ProjectRepositoryError {
  return new ProjectRepositoryError('invalid-project-input');
}
