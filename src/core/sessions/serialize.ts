import { encodeJson, type CheckpointPayload } from "../contracts/index.ts";

/**
 * Serializes a complete, successfully collected `CheckpointPayload` to detached
 * JSON bytes via the shared `encodeJson` contract.
 *
 * This is only the serialization step of a checkpoint; compression, encryption,
 * and artifact writing are separate. The collector always either returns a
 * complete payload or throws, so there is no partial payload to serialize.
 * `encodeJson` additionally rejects non-JSON-stable values instead of silently
 * omitting or coercing them.
 */
export function serializeCheckpointPayload(payload: CheckpointPayload): Uint8Array {
	return encodeJson(payload);
}
