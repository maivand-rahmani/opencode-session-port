import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuotaAccountingError,
  addReservedBytes,
  assertReservationAllowed,
  canReserve,
  isSafeByteCount,
  lockQuotaForUpdate,
  moveReservedToUsed,
  releaseReservedBytes,
} from '../../src/quota/accounting.js';
import type {
  QuotaAccountingErrorCode,
  QuotaAccountingTransaction,
  QuotaLockRow,
  QuotaSnapshot,
} from '../../src/quota/accounting.js';

/*
 * Focused pure/unit tests against a tiny transaction fake. They prove the
 * reservation predicate, fixed error mapping, tagged static SQL, update shape,
 * and fail-closed underflow checks. They do NOT prove PostgreSQL locking,
 * isolation, constraint execution, or concurrent behaviour.
 */

const USER_ID = 'user_01HQUOTATESTOPAQUE';
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const EXPECTED: Readonly<
  Record<QuotaAccountingErrorCode, { statusCode: number; retryable: boolean; message: string }>
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

interface QuotaUpdateCall {
  readonly where: { readonly userID: string };
  readonly data: Record<string, unknown>;
  readonly select: { readonly userID: true };
}

class FakeQuotaTransaction {
  readonly order: string[] = [];
  readonly rawCalls: Array<{ strings: string[]; values: unknown[]; sql: string }> = [];
  readonly updateCalls: QuotaUpdateCall[] = [];

  constructor(
    private readonly rows: QuotaLockRow[],
    private readonly updateError?: unknown,
  ) {}

  readonly userQuota = {
    update: async (args: QuotaUpdateCall): Promise<{ userID: string }> => {
      this.order.push('quota-update');
      this.updateCalls.push(args);
      if (this.updateError !== undefined) {
        throw this.updateError;
      }
      return { userID: args.where.userID };
    },
  };

  async $queryRaw<T>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    this.order.push('quota-lock');
    this.rawCalls.push({
      strings: Array.from(strings),
      values,
      sql: strings.join('?').replace(/\s+/g, ' ').trim(),
    });
    return this.rows as unknown as T;
  }
}

function quota(overrides: Partial<QuotaLockRow> = {}): QuotaLockRow {
  return {
    userID: USER_ID,
    limitBytes: 1_000n,
    usedBytes: 100n,
    reservedBytes: 50n,
    ...overrides,
  };
}

function snapshot(row: QuotaLockRow): QuotaSnapshot {
  return {
    limitBytes: row.limitBytes,
    usedBytes: row.usedBytes,
    reservedBytes: row.reservedBytes,
  };
}

function assertQuotaError(
  error: unknown,
  code: QuotaAccountingErrorCode,
  secrets: readonly string[] = [],
): boolean {
  assert.ok(error instanceof QuotaAccountingError);
  assert.equal(error.name, 'QuotaAccountingError');
  assert.equal(error.code, code);
  assert.equal(error.statusCode, EXPECTED[code].statusCode);
  assert.equal(error.retryable, EXPECTED[code].retryable);
  assert.equal(error.message, EXPECTED[code].message);
  assert.equal(error.cause, undefined);
  const rendered = `${String(error)} ${error.stack ?? ''} ${JSON.stringify(error)}`;
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false);
  }
  return true;
}

test('canReserve allows exact fit and rejects oversized or over-limit reservations', () => {
  const row = quota();
  assert.deepEqual(canReserve(snapshot(row), 850n, 1_000n), { allowed: true });
  assert.equal(isSafeByteCount(0n), true);
  assert.equal(isSafeByteCount(MAX_SAFE), true);

  const tooLarge = [
    canReserve(snapshot(row), 0n, 1_000n),
    canReserve(snapshot(row), -1n, 1_000n),
    canReserve(snapshot(row), 1_001n, 1_000n),
    canReserve(snapshot(row), 1n, 0n),
  ];
  for (const check of tooLarge) {
    assert.deepEqual(check, { allowed: false, code: 'ciphertext-too-large' });
  }

  assert.deepEqual(canReserve(snapshot(row), 851n, 1_000n), {
    allowed: false,
    code: 'storage-limit-reached',
  });
});

test('canReserve fails closed on unsafe, negative, or inconsistent stored counters', () => {
  const invalidSnapshots: QuotaSnapshot[] = [
    { limitBytes: -1n, usedBytes: 0n, reservedBytes: 0n },
    { limitBytes: MAX_SAFE + 1n, usedBytes: 0n, reservedBytes: 0n },
    { limitBytes: 1_000n, usedBytes: -1n, reservedBytes: 0n },
    { limitBytes: 1_000n, usedBytes: 0n, reservedBytes: MAX_SAFE + 1n },
    {
      limitBytes: 100n,
      usedBytes: 80n,
      reservedBytes: 30n,
    },
  ];

  for (const value of invalidSnapshots) {
    assert.deepEqual(canReserve(value, 1n, 100n), {
      allowed: false,
      code: 'quota-invalid',
    });
    assert.throws(
      () => assertReservationAllowed(value, 1n, 100n),
      (error: unknown) => assertQuotaError(error, 'quota-invalid'),
    );
  }

  assert.equal(isSafeByteCount(MAX_SAFE + 1n), false);
  assert.equal(isSafeByteCount(-1n), false);
  assert.equal(isSafeByteCount(1), false);
});

test('assertReservationAllowed maps max-size and storage failures to fixed 422/413', () => {
  const row = quota();
  assert.throws(
    () => assertReservationAllowed(snapshot(row), 1_001n, 1_000n),
    (error: unknown) => assertQuotaError(error, 'ciphertext-too-large'),
  );
  assert.throws(
    () => assertReservationAllowed(snapshot(row), 851n, 1_000n),
    (error: unknown) => assertQuotaError(error, 'storage-limit-reached'),
  );
});

test('lockQuotaForUpdate uses static tagged SQL and fails closed when missing', async () => {
  const injected = `user_01'; DROP TABLE "UserQuota"; -- secret`;
  const fake = new FakeQuotaTransaction([quota({ userID: injected })]);
  const locked = await lockQuotaForUpdate(
    fake as unknown as QuotaAccountingTransaction,
    injected,
  );

  assert.equal(locked.userID, injected);
  assert.deepEqual(fake.rawCalls[0]?.values, [injected]);
  assert.equal(fake.rawCalls[0]?.strings.includes(injected), false);
  assert.equal(
    fake.rawCalls[0]?.sql,
    'SELECT "userID", "limitBytes", "usedBytes", "reservedBytes" FROM "UserQuota" WHERE "userID" = ? FOR UPDATE',
  );

  const missing = new FakeQuotaTransaction([]);
  await assert.rejects(
    lockQuotaForUpdate(
      missing as unknown as QuotaAccountingTransaction,
      USER_ID,
    ),
    (error: unknown) => assertQuotaError(error, 'quota-not-provisioned'),
  );
  assert.equal(missing.updateCalls.length, 0);
});

test('lockQuotaForUpdate rejects a row bound to a different user or unsafe counters', async () => {
  for (const row of [
    quota({ userID: 'user_other' }),
    quota({ usedBytes: MAX_SAFE + 1n }),
    quota({ limitBytes: 10n, usedBytes: 10n, reservedBytes: 1n }),
  ]) {
    const fake = new FakeQuotaTransaction([row]);
    await assert.rejects(
      lockQuotaForUpdate(
        fake as unknown as QuotaAccountingTransaction,
        USER_ID,
      ),
      (error: unknown) => assertQuotaError(error, 'quota-invalid'),
    );
  }
});

test('addReservedBytes increments reserved exactly once after the locked check', async () => {
  const fake = new FakeQuotaTransaction([]);
  const row = quota();
  await addReservedBytes(
    fake as unknown as QuotaAccountingTransaction,
    row,
    850n,
  );

  assert.deepEqual(fake.updateCalls, [
    {
      where: { userID: USER_ID },
      data: { reservedBytes: { increment: 850n } },
      select: { userID: true },
    },
  ]);

  await assert.rejects(
    addReservedBytes(
      fake as unknown as QuotaAccountingTransaction,
      row,
      851n,
    ),
    (error: unknown) => assertQuotaError(error, 'storage-limit-reached'),
  );
  assert.equal(fake.updateCalls.length, 1);
});

test('moveReservedToUsed moves bytes once and fails closed on underflow', async () => {
  const fake = new FakeQuotaTransaction([]);
  await moveReservedToUsed(
    fake as unknown as QuotaAccountingTransaction,
    quota(),
    50n,
  );
  assert.deepEqual(fake.updateCalls[0], {
    where: { userID: USER_ID },
    data: {
      reservedBytes: { decrement: 50n },
      usedBytes: { increment: 50n },
    },
    select: { userID: true },
  });

  await assert.rejects(
    moveReservedToUsed(
      fake as unknown as QuotaAccountingTransaction,
      quota({ reservedBytes: 49n }),
      50n,
    ),
    (error: unknown) => assertQuotaError(error, 'quota-underflow'),
  );
  assert.equal(fake.updateCalls.length, 1);
});

test('releaseReservedBytes decrements once and refuses an underflow', async () => {
  const fake = new FakeQuotaTransaction([]);
  await releaseReservedBytes(
    fake as unknown as QuotaAccountingTransaction,
    quota(),
    50n,
  );
  assert.deepEqual(fake.updateCalls[0], {
    where: { userID: USER_ID },
    data: { reservedBytes: { decrement: 50n } },
    select: { userID: true },
  });

  await assert.rejects(
    releaseReservedBytes(
      fake as unknown as QuotaAccountingTransaction,
      quota({ reservedBytes: 0n }),
      1n,
    ),
    (error: unknown) => assertQuotaError(error, 'quota-underflow'),
  );
  assert.equal(fake.updateCalls.length, 1);
});

test('unexpected update failures are not wrapped by accounting and leak no driver text', async () => {
  const secret = 'postgres://secret-user:secret-password@db/internal';
  const fake = new FakeQuotaTransaction([], new Error(secret));
  await assert.rejects(
    addReservedBytes(
      fake as unknown as QuotaAccountingTransaction,
      quota(),
      1n,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, secret);
      return true;
    },
  );
});
