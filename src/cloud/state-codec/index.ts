/**
 * Selected local-state codec entry point (V2, SECURITY.md 5.1 decision).
 *
 * The exported surface is intentionally small: the factory, the shared scope
 * validator (for the independent state-key lane), and the fixed format
 * constants integration needs. There is no configuration-default policy.
 */
export {
	createAuthenticatedStateCodec,
	STATE_CODEC_ENVELOPE_OVERHEAD_BYTES,
	STATE_CODEC_HEADER_BYTES,
	STATE_CODEC_KEY_BYTES,
	STATE_CODEC_MAGIC,
	STATE_CODEC_MAX_ENVELOPE_BYTES,
	STATE_CODEC_MAX_PLAINTEXT_BYTES,
	STATE_CODEC_MAX_SCOPE_BYTES,
	STATE_CODEC_MIN_ENVELOPE_BYTES,
	STATE_CODEC_NONCE_BYTES,
	STATE_CODEC_PURPOSE,
	STATE_CODEC_TAG_BYTES,
	STATE_CODEC_VERSION,
	STATE_CODEC_VERSION_FIELD,
	validateStateScope,
} from "./codec.ts";
export { StateCodecError } from "./errors.ts";
export type { StateCodecErrorCode } from "./errors.ts";
export type { AuthenticatedStateCodec, StateCodecContext } from "../state/types.ts";
