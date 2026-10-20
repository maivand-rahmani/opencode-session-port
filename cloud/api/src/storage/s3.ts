/**
 * Low-level, unmounted S3 operations.
 *
 * These helpers are server-only building blocks. They are not HTTP routes, do not
 * read environment variables, do not log, and do not enable uploads. Business
 * uploads remain blocked until provider capability evidence (including checksum
 * and conditional-copy behaviour) and integration are established separately.
 *
 * The adapter intentionally keeps a very small surface:
 * - POST policy signing for a caller-allocated staging key;
 * - HEAD verification with a mandatory SHA-256 checksum;
 * - conditional same-bucket copy with `CopySourceIfMatch`;
 * - explicit-TTL GET signing.
 *
 * Destination immutability is NOT guaranteed here. The service must allocate a
 * unique final key per lease/generation. No provider transaction, prefix lock, or
 * bucket-level guarantee is invented by this module.
 */

import {
  ChecksumAlgorithm,
  ChecksumMode,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import {
  createPresignedPost,
  type PresignedPostOptions,
} from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3Config } from './config.js';

const MAX_KEY_BYTES = 1024;
const MAX_ETAG_LENGTH = 1024;
const MAX_PRESIGN_TTL_SECONDS = 604_800;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CANONICAL_BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;

export type S3StorageErrorCode =
  | 'invalid-input'
  | 'unsupported-integrity'
  | 'precondition-failed'
  | 'not-found'
  | 'unavailable';

const ERROR_MESSAGES: Readonly<Record<S3StorageErrorCode, string>> =
  Object.freeze({
    'invalid-input': 'S3 request input is invalid.',
    'unsupported-integrity':
      'S3 object integrity metadata is unavailable or invalid.',
    'precondition-failed': 'S3 object precondition failed.',
    'not-found': 'S3 object was not found.',
    unavailable: 'S3 operation failed.',
  });

/**
 * Fixed, redacted storage error.
 *
 * The message and code are the only exposed fields. Raw SDK errors, URLs, keys,
 * credentials, request ids, and causes are never retained or attached.
 */
export class S3StorageError extends Error {
  readonly code: S3StorageErrorCode;

  constructor(code: S3StorageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'S3StorageError';
    this.code = code;
  }
}

export interface CreateUploadPolicyInput {
  readonly key: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly expiresInSeconds: number;
}

export interface UploadPolicy {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export interface HeadObjectInput {
  readonly key: string;
}

export interface StoredObjectMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly etag: string;
}

export interface CopyObjectInput {
  readonly sourceKey: string;
  readonly destinationKey: string;
  readonly sourceETag: string;
}

export interface CreateDownloadUrlInput {
  readonly key: string;
  readonly expiresInSeconds: number;
}

export interface S3Storage {
  createUploadPolicy(input: CreateUploadPolicyInput): Promise<UploadPolicy>;
  headObject(input: HeadObjectInput): Promise<StoredObjectMetadata>;
  copyObject(input: CopyObjectInput): Promise<void>;
  createDownloadUrl(input: CreateDownloadUrlInput): Promise<string>;
}

/**
 * Create the storage adapter.
 *
 * Supplying a client is an explicit test seam only. The default client uses the
 * supplied static credentials, custom HTTPS endpoint, region, and address style.
 * Checksum defaults are narrowed to `WHEN_REQUIRED` so the adapter does not rely
 * on the SDK's unproven CRC32 default for these operations; explicit SHA-256
 * remains mandatory at the method level.
 */
export function createS3Storage(
  config: S3Config,
  client?: S3Client,
): S3Storage {
  let s3: S3Client;
  try {
    s3 =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  } catch {
    throw new S3StorageError('invalid-input');
  }

  async function createUploadPolicy(
    rawInput: CreateUploadPolicyInput,
  ): Promise<UploadPolicy> {
    const input = requireInputRecord(rawInput);
    const key = requireObjectKey(input.key);
    const sizeBytes = requireBoundedInteger(
      input.sizeBytes,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const checksumSha256 = requireSha256Base64(
      input.checksumSha256,
      'invalid-input',
    );
    const expiresInSeconds = requireBoundedInteger(
      input.expiresInSeconds,
      1,
      MAX_PRESIGN_TTL_SECONDS,
    );

    const conditions: NonNullable<PresignedPostOptions['Conditions']> = [
      ['eq', '$key', key],
      ['content-length-range', sizeBytes, sizeBytes],
      ['eq', '$x-amz-checksum-algorithm', 'SHA256'],
      ['eq', '$x-amz-checksum-sha256', checksumSha256],
    ];

    try {
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: config.bucket,
        Key: key,
        Expires: expiresInSeconds,
        Fields: {
          key,
          'x-amz-checksum-algorithm': 'SHA256',
          'x-amz-checksum-sha256': checksumSha256,
        },
        Conditions: conditions,
      });

      return Object.freeze({
        url,
        fields: Object.freeze({ ...fields }),
      });
    } catch {
      throw new S3StorageError('unavailable');
    }
  }

  async function headObject(
    rawInput: HeadObjectInput,
  ): Promise<StoredObjectMetadata> {
    const input = requireInputRecord(rawInput);
    const key = requireObjectKey(input.key);

    const output = await sendHeadObject(s3, config.bucket, key);
    if (typeof output !== 'object' || output === null) {
      throw new S3StorageError('unavailable');
    }

    const sizeBytes = requireResponseContentLength(output.ContentLength);
    const checksumSha256 = requireSha256Base64(
      output.ChecksumSHA256,
      'unsupported-integrity',
    );
    const etag = requireOpaqueEtag(output.ETag, 'unavailable');

    return Object.freeze({
      key,
      sizeBytes,
      checksumSha256,
      etag,
    });
  }

  async function copyObject(rawInput: CopyObjectInput): Promise<void> {
    const input = requireInputRecord(rawInput);
    const sourceKey = requireObjectKey(input.sourceKey);
    const destinationKey = requireObjectKey(input.destinationKey);
    if (sourceKey === destinationKey) {
      throw new S3StorageError('invalid-input');
    }
    const sourceETag = requireOpaqueEtag(input.sourceETag, 'invalid-input');

    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          Key: destinationKey,
          CopySource: buildCopySource(config.bucket, sourceKey),
          CopySourceIfMatch: sourceETag,
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
        }),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async function createDownloadUrl(
    rawInput: CreateDownloadUrlInput,
  ): Promise<string> {
    const input = requireInputRecord(rawInput);
    const key = requireObjectKey(input.key);
    const expiresInSeconds = requireBoundedInteger(
      input.expiresInSeconds,
      1,
      MAX_PRESIGN_TTL_SECONDS,
    );

    try {
      return await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }),
        { expiresIn: expiresInSeconds },
      );
    } catch {
      throw new S3StorageError('unavailable');
    }
  }

  return Object.freeze({
    createUploadPolicy,
    headObject,
    copyObject,
    createDownloadUrl,
  });
}

async function sendHeadObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<HeadObjectCommandOutput> {
  try {
    return await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: ChecksumMode.ENABLED,
      }),
    );
  } catch (error) {
    throw toStorageError(error);
  }
}

function requireInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new S3StorageError('invalid-input');
  }
  return value as Record<string, unknown>;
}

function requireObjectKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new S3StorageError('invalid-input');
  }
  if (value.trim().length === 0) {
    throw new S3StorageError('invalid-input');
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new S3StorageError('invalid-input');
  }
  if (value.includes('${filename}')) {
    throw new S3StorageError('invalid-input');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_KEY_BYTES) {
    throw new S3StorageError('invalid-input');
  }

  return value;
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new S3StorageError('invalid-input');
  }
  return value;
}

function requireResponseContentLength(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new S3StorageError('unavailable');
  }
  return value;
}

function requireSha256Base64(
  value: unknown,
  code: 'invalid-input' | 'unsupported-integrity',
): string {
  if (typeof value !== 'string' || !CANONICAL_BASE64_SHA256.test(value)) {
    throw new S3StorageError(code);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new S3StorageError(code);
  }

  return value;
}

function requireOpaqueEtag(
  value: unknown,
  code: 'invalid-input' | 'unavailable',
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ETAG_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new S3StorageError(code);
  }
  return value;
}

function buildCopySource(bucket: string, sourceKey: string): string {
  const encodedKey = sourceKey
    .split('/')
    .map(encodeCopySourceSegment)
    .join('/');
  return `/${encodeURIComponent(bucket)}/${encodedKey}`;
}

function encodeCopySourceSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function toStorageError(error: unknown): S3StorageError {
  const status = readHttpStatus(error);
  if (status === 412) {
    return new S3StorageError('precondition-failed');
  }
  if (status === 404) {
    return new S3StorageError('not-found');
  }

  const name = readErrorName(error);
  if (name === 'PreconditionFailed') {
    return new S3StorageError('precondition-failed');
  }
  if (name === 'NoSuchKey' || name === 'NotFound') {
    return new S3StorageError('not-found');
  }

  return new S3StorageError('unavailable');
}

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }

  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === 'number' && Number.isInteger(status)
    ? status
    : undefined;
}

function readErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}
