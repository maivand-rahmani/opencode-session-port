import type { JsonObject } from "../contracts/index.ts";
import { isJsonObject } from "./guards.ts";

/**
 * Reasons a message is "unsettled" under the official v2.0.22 transfer/import
 * filter (E15). Such messages would be silently dropped by import/export;
 * because completeness is DECIDED (P-05) the checkpoint must fail closed
 * instead of filtering them.
 */
export type UnsettledMessageReason =
	| "assistant-without-completion"
	| "shell-running"
	| "compaction-running";

/**
 * Detects messages that official transfer/import would drop:
 * - assistant message without a numeric `time.completed`;
 * - shell message with `status: "running"`;
 * - compaction message with `status: "running"`.
 *
 * Unknown message types, unknown statuses, and unknown fields are preserved,
 * not filtered or coerced. This mirrors the researched v2.0.22 rules only; it
 * is not a general schema validator and it makes no claim beyond E15.
 */
export function findUnsettledMessageReason(message: JsonObject): UnsettledMessageReason | undefined {
	const type = message["type"];
	if (type === "assistant") {
		const time = message["time"];
		const completed = isJsonObject(time) ? time["completed"] : undefined;
		if (typeof completed !== "number") return "assistant-without-completion";
	}
	if (type === "shell" && message["status"] === "running") return "shell-running";
	if (type === "compaction" && message["status"] === "running") return "compaction-running";
	return undefined;
}
