/**
 * Quota accounting primitives shared by upload reservation/finalization.
 *
 * This module is deliberately small: a pure reservation check, a tagged
 * `FOR UPDATE` quota-row read, and three transaction mutators. It is not a
 * generic persistence framework and it never creates a quota row. Callers must
 * already hold the tenant's `UserQuota` row lock before invoking a mutator.
 *
 * All persisted byte counters are Prisma `BigInt` values. They are accepted
 * only when the count is a non-negative safe integer representable as a JSON
 * number; anything else fails closed as `quota-invalid`. Arithmetic itself is
 * done in `BigInt` so no intermediate overflow can wrap a limit check.
 *
 * Lock ordering is part of the contract: every upload operation that changes
 * quota locks `UserQuota` before it locks `Upload`.
 */

import type { Prisma } from '../../prisma/generated/client/client.js';

/** Largest byte count that can be returned as a JSON number without loss. */
export const MAX_SAFE_BYTE_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

export type QuotaAccountingErrorCode =
  | 'quota-not-provisioned'
  | 'ciphertext-too-large'
  | 'storage-limit-reached'
  | 'quota-invalid'
  | 'quota-underflow';

interface QuotaAccountingErrorDefinition {
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly message: string;
}

// Fixed, public-safe messages. No identifiers or driver text belong here.
const ERROR_DEFINITIONS: Readonly<
  Record<QuotaAccountingErrorCode, QuotaAccountingErrorDefinition>
> = {
  'quota-not-provisioned': {
    statusCode: 500,
    retryable: false,
    message: 'The user quota is not provisioned.',
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
};

export class QuotaAccountingError extends Error {
  readonly code: QuotaAccountingErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(code: QuotaAccountingErrorCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = 'QuotaAccountingError';
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

export interface QuotaLockRow {
  readonly userID: string;
  readonly limitBytes: bigint;
  readonly usedBytes: bigint;
  readonly reservedBytes: bigint;
}

export type QuotaSnapshot = Omit<QuotaLockRow, 'userID'>;

export type ReservationCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'ciphertext-too-large' | 'storage-limit-reached' | 'quota-invalid';
    };

/**
 * The transaction surface accounting needs. Tests can supply a small fake that
 * only implements these two members.
 */
export type QuotaAccountingTransaction = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'userQuota'
>;

/** True only for a non-negative safe-integer byte count. */
export function isSafeByteCount(value: unknown): value is bigint {
  return (
    typeof value === 'bigint' &&
    value >= 0n &&
    value <= MAX_SAFE_BYTE_VALUE
  );
}

/** True only for a strictly positive safe-integer byte count. */
export function isPositiveSafeByteCount(value: unknown): value is bigint {
  return isSafeByteCount(value) && value > 0n;
}

/**
 * Pure quota decision. It never mutates and never throws; the repository maps
 * a rejected check to the fixed quota error with the same code.
 */
export function canReserve(
  quota: QuotaSnapshot,
  sizeBytes: bigint,
  maxCiphertextBytes: bigint,
): ReservationCheck {
  if (
    !isPositiveSafeByteCount(sizeBytes) ||
    !isPositiveSafeByteCount(maxCiphertextBytes) ||
    sizeBytes > maxCiphertextBytes
  ) {
    return { allowed: false, code: 'ciphertext-too-large' };
  }

  if (!isConsistentQuota(quota)) {
    return { allowed: false, code: 'quota-invalid' };
  }

  if (quota.usedBytes + quota.reservedBytes + sizeBytes > quota.limitBytes) {
    return { allowed: false, code: 'storage-limit-reached' };
  }

  return { allowed: true };
}

/** Throw the fixed tagged error when `canReserve` rejects the request. */
export function assertReservationAllowed(
  quota: QuotaSnapshot,
  sizeBytes: bigint,
  maxCiphertextBytes: bigint,
): void {
  const check = canReserve(quota, sizeBytes, maxCiphertextBytes);
  if (!check.allowed) {
    throw new QuotaAccountingError(check.code);
  }
}

/**
 * Lock and read the tenant quota row. The SQL text is static and `userID` is a
 * bound tagged-template parameter; no identifier or value is interpolated into
 * SQL text. A missing row is a provisioning failure, not an invitation to
 * create one.
 */
export async function lockQuotaForUpdate(
  transaction: QuotaAccountingTransaction,
  userID: string,
): Promise<QuotaLockRow> {
  const rows = await transaction.$queryRaw<QuotaLockRow[]>`
    SELECT "userID", "limitBytes", "usedBytes", "reservedBytes"
    FROM "UserQuota"
    WHERE "userID" = ${userID}
    FOR UPDATE
  `;

  if (rows.length === 0) {
    throw new QuotaAccountingError('quota-not-provisioned');
  }
  if (rows.length !== 1) {
    throw new QuotaAccountingError('quota-invalid');
  }

  const row = rows[0];
  if (row.userID !== userID || !isConsistentQuota(row)) {
    throw new QuotaAccountingError('quota-invalid');
  }

  return row;
}

/**
 * Add to `reservedBytes` exactly once. The caller must hold the quota row lock
 * and must have passed `assertReservationAllowed` against the same snapshot.
 */
export async function addReservedBytes(
  transaction: QuotaAccountingTransaction,
  quota: QuotaLockRow,
  sizeBytes: bigint,
): Promise<void> {
  assertLockedQuota(quota);

  if (!isPositiveSafeByteCount(sizeBytes)) {
    throw new QuotaAccountingError('quota-invalid');
  }

  const projected = quota.usedBytes + quota.reservedBytes + sizeBytes;
  if (projected > quota.limitBytes || projected > MAX_SAFE_BYTE_VALUE) {
    throw new QuotaAccountingError('storage-limit-reached');
  }

  await transaction.userQuota.update({
    where: { userID: quota.userID },
    data: { reservedBytes: { increment: sizeBytes } },
    select: { userID: true },
  });
}

/**
 * Move reserved bytes into used bytes exactly once. This is the only attach
 * accounting transition; it fails closed if the reservation underflows.
 */
export async function moveReservedToUsed(
  transaction: QuotaAccountingTransaction,
  quota: QuotaLockRow,
  sizeBytes: bigint,
): Promise<void> {
  assertLockedQuota(quota);

  if (!isPositiveSafeByteCount(sizeBytes)) {
    throw new QuotaAccountingError('quota-invalid');
  }
  if (quota.reservedBytes < sizeBytes) {
    throw new QuotaAccountingError('quota-underflow');
  }
  if (quota.usedBytes + sizeBytes > quota.limitBytes) {
    throw new QuotaAccountingError('quota-invalid');
  }

  await transaction.userQuota.update({
    where: { userID: quota.userID },
    data: {
      reservedBytes: { decrement: sizeBytes },
      usedBytes: { increment: sizeBytes },
    },
    select: { userID: true },
  });
}

/**
 * Release a reservation exactly once. Used only for expiry paths; a ready or
 * committed object must never be released without a confirmed external delete.
 */
export async function releaseReservedBytes(
  transaction: QuotaAccountingTransaction,
  quota: QuotaLockRow,
  sizeBytes: bigint,
): Promise<void> {
  assertLockedQuota(quota);

  if (!isPositiveSafeByteCount(sizeBytes)) {
    throw new QuotaAccountingError('quota-invalid');
  }
  if (quota.reservedBytes < sizeBytes) {
    throw new QuotaAccountingError('quota-underflow');
  }

  await transaction.userQuota.update({
    where: { userID: quota.userID },
    data: { reservedBytes: { decrement: sizeBytes } },
    select: { userID: true },
  });
}

function assertLockedQuota(quota: QuotaLockRow): void {
  if (
    typeof quota.userID !== 'string' ||
    quota.userID.length === 0 ||
    !isConsistentQuota(quota)
  ) {
    throw new QuotaAccountingError('quota-invalid');
  }
}

function isConsistentQuota(quota: QuotaSnapshot): boolean {
  if (
    !isSafeByteCount(quota.limitBytes) ||
    !isSafeByteCount(quota.usedBytes) ||
    !isSafeByteCount(quota.reservedBytes)
  ) {
    return false;
  }

  return quota.usedBytes + quota.reservedBytes <= quota.limitBytes;
}
