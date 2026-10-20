/**
 * Tenant-scoped usage and limits read model for `GET /v1/me`.
 *
 * The caller supplies only an already-authenticated vendor `userID`. Every
 * query is scoped by that user. Limits come from explicit caller configuration
 * plus the provisioned `UserQuota` row; this module invents no product caps and
 * does not create a quota row.
 *
 * Active devices are derived from `NativeDeviceGrant` because `Device` has no
 * status column: a device is active only while its related grant is `active`
 * and unexpired.
 *
 * Persisted byte counters are `BigInt`. They are returned as JSON numbers only
 * when every value is a non-negative safe integer; otherwise the read fails
 * closed with a fixed 500 rather than truncating or masking corruption.
 */

import type { PrismaClient } from '../../prisma/generated/client/client.js';

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type MeRepositoryErrorCode =
  | 'invalid-me-input'
  | 'quota-not-provisioned'
  | 'quota-invalid'
  | 'repository-unavailable';

interface MeRepositoryErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

const ERROR_DEFINITIONS: Readonly<
  Record<MeRepositoryErrorCode, MeRepositoryErrorDefinition>
> = {
  'invalid-me-input': {
    statusCode: 422,
    retryable: false,
    message: 'The usage query is invalid.',
  },
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
  },
  'quota-invalid': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is invalid.',
  },
  'repository-unavailable': {
    statusCode: 503,
    retryable: true,
    message: 'The usage repository is temporarily unavailable.',
  },
};

export class MeRepositoryError extends Error {
  readonly code: MeRepositoryErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: MeRepositoryErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'MeRepositoryError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

export type MeRepositoryClient = Pick<
  PrismaClient,
  'userQuota' | 'project' | 'nativeDeviceGrant'
>;

export interface MeRepositoryLimits {
  /** Explicit, required, positive safe integers. No product defaults. */
  readonly maxCiphertextBytes: number;
  readonly maxActiveDevices: number;
  readonly maxActiveProjects: number;
}

export interface MeRepositoryOptions extends MeRepositoryLimits {
  /** Trusted server clock injection for deterministic tests. */
  readonly now?: () => Date;
}

export interface MeLimitsDTO {
  readonly storageLimitBytes: number;
  readonly storageUsedBytes: number;
  readonly storageReservedBytes: number;
  readonly maxCiphertextBytes: number;
  readonly maxActiveDevices: number;
  readonly maxActiveProjects: number;
}

export interface MeCountsDTO {
  readonly activeDevices: number;
  readonly activeProjects: number;
}

export interface MeDTO {
  readonly userID: string;
  readonly limits: MeLimitsDTO;
  readonly counts: MeCountsDTO;
}

export interface MeRepository {
  read(userID: string): Promise<MeDTO>;
}

export function createMeRepository(
  client: MeRepositoryClient,
  options: MeRepositoryOptions,
): MeRepository {
  const limits = readLimits(options);
  const now = readNow(options.now);

  return Object.freeze({
    read: (userID: string) => readMe(client, limits, now, userID),
  });
}

async function readMe(
  client: MeRepositoryClient,
  limits: MeRepositoryLimits,
  now: () => Date,
  rawUserID: unknown,
): Promise<MeDTO> {
  const userID = readUserID(rawUserID);

  try {
    const quota = await client.userQuota.findUnique({
      where: { userID },
      select: {
        limitBytes: true,
        usedBytes: true,
        reservedBytes: true,
      },
    });

    if (quota === null) {
      throw new MeRepositoryError('quota-not-provisioned');
    }

    const storageLimitBytes = toSafeByteNumber(quota.limitBytes);
    const storageUsedBytes = toSafeByteNumber(quota.usedBytes);
    const storageReservedBytes = toSafeByteNumber(quota.reservedBytes);

    if (
      BigInt(storageUsedBytes) + BigInt(storageReservedBytes) >
      BigInt(storageLimitBytes)
    ) {
      throw new MeRepositoryError('quota-invalid');
    }

    const currentTime = now();
    if (
      !(currentTime instanceof Date) ||
      Number.isNaN(currentTime.getTime())
    ) {
      throw new MeRepositoryError('repository-unavailable');
    }

    // Counts are tenant-scoped. Active devices derive from the grant because
    // Device has no independent status column.
    const [activeProjects, activeDevices] = await Promise.all([
      client.project.count({
        where: { userID, state: 'active' },
      }),
      client.nativeDeviceGrant.count({
        where: {
          userID,
          status: 'active',
          expiresAt: { gt: currentTime },
        },
      }),
    ]);

    return Object.freeze({
      userID,
      limits: Object.freeze({
        storageLimitBytes,
        storageUsedBytes,
        storageReservedBytes,
        maxCiphertextBytes: limits.maxCiphertextBytes,
        maxActiveDevices: limits.maxActiveDevices,
        maxActiveProjects: limits.maxActiveProjects,
      }),
      counts: Object.freeze({
        activeDevices,
        activeProjects,
      }),
    });
  } catch (error) {
    throw sanitizeMeError(error);
  }
}

function readLimits(rawOptions: unknown): MeRepositoryLimits {
  if (
    typeof rawOptions !== 'object' ||
    rawOptions === null ||
    Array.isArray(rawOptions)
  ) {
    throw inputError();
  }

  const options = rawOptions as {
    readonly maxCiphertextBytes?: unknown;
    readonly maxActiveDevices?: unknown;
    readonly maxActiveProjects?: unknown;
  };

  return Object.freeze({
    maxCiphertextBytes: readLimit(options.maxCiphertextBytes),
    maxActiveDevices: readLimit(options.maxActiveDevices),
    maxActiveProjects: readLimit(options.maxActiveProjects),
  });
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw inputError();
  }
  return value;
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

function readUserID(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  ) {
    throw inputError();
  }
  return value;
}

function toSafeByteNumber(value: unknown): number {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > MAX_SAFE_BIGINT
  ) {
    throw new MeRepositoryError('quota-invalid');
  }
  return Number(value);
}

function sanitizeMeError(error: unknown): MeRepositoryError {
  if (error instanceof MeRepositoryError) {
    return error;
  }
  return new MeRepositoryError('repository-unavailable');
}

function inputError(): MeRepositoryError {
  return new MeRepositoryError('invalid-me-input');
}
