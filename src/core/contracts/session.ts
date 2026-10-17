import type { JsonObject } from "./json.ts";

/** OpenCode transfer object retained as JSON without narrowing message variants. */
export interface SessionRecord {
	readonly info: JsonObject;
	readonly messages: readonly JsonObject[];
}

/** Payload shared between session collection, serialization, and restore preflight. */
export interface CheckpointPayload {
	readonly sessions: readonly SessionRecord[];
}
