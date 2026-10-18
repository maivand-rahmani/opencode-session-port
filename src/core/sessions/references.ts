import type { JsonObject } from "../contracts/index.ts";
import { isJsonObject } from "./guards.ts";

/**
 * Shared schema-reference validation for one session `info` record.
 *
 * This is the single implementation of the schema-defined reference rules:
 * - `info.parentID` is optional; when present it must be a string starting
 *   with `ses`.
 * - When `info.fork` is present it must be an object carrying a string
 *   `sessionID` starting with `ses`, an object `boundary` whose `type` is
 *   exactly `before`/`through`, and a string `boundary.messageID` starting
 *   with `msg_`.
 * - When `info.revert` is present it must carry a string `messageID` starting
 *   with `msg_`.
 *
 * A present value that does not match fails closed instead of being treated as
 * absent; absent-vs-null is preserved (a present `null` reference is a
 * violation, never normalized away). Unknown fields are untouched.
 *
 * The restore planner (`validateSchemaReferences` in `restore/planner.ts`) and
 * the checkpoint dependency collector (`dependencies.ts`) both call this
 * function, so the two lanes can never drift on reference rules. It returns
 * the planner-identical violation message (or `undefined`); callers throw
 * their own error type with their own stable code.
 */
export function findSchemaReferenceViolation(info: JsonObject, infoLabel: string): string | undefined {
	const parentID = info["parentID"];
	if (parentID !== undefined && (typeof parentID !== "string" || !parentID.startsWith(SESSION_REFERENCE_PREFIX))) {
		return `${infoLabel}.parentID must be a string starting with ${JSON.stringify(SESSION_REFERENCE_PREFIX)} when present`;
	}

	const fork = info["fork"];
	if (fork !== undefined) {
		if (!isJsonObject(fork)) {
			return `${infoLabel}.fork must be an object when present`;
		}
		const forkSessionID = fork["sessionID"];
		if (typeof forkSessionID !== "string" || !forkSessionID.startsWith(SESSION_REFERENCE_PREFIX)) {
			return `${infoLabel}.fork.sessionID must be a string starting with ${JSON.stringify(SESSION_REFERENCE_PREFIX)}`;
		}
		const boundary = fork["boundary"];
		if (!isJsonObject(boundary)) {
			return `${infoLabel}.fork.boundary must be an object`;
		}
		const boundaryType = boundary["type"];
		if (boundaryType !== "before" && boundaryType !== "through") {
			return `${infoLabel}.fork.boundary.type must be exactly "before" or "through"`;
		}
		const boundaryMessageID = boundary["messageID"];
		if (typeof boundaryMessageID !== "string" || !boundaryMessageID.startsWith(MESSAGE_REFERENCE_PREFIX)) {
			return `${infoLabel}.fork.boundary.messageID must be a string starting with ${JSON.stringify(MESSAGE_REFERENCE_PREFIX)}`;
		}
	}

	const revert = info["revert"];
	if (revert !== undefined) {
		if (!isJsonObject(revert)) {
			return `${infoLabel}.revert must be an object when present`;
		}
		const revertMessageID = revert["messageID"];
		if (typeof revertMessageID !== "string" || !revertMessageID.startsWith(MESSAGE_REFERENCE_PREFIX)) {
			return `${infoLabel}.revert.messageID must be a string starting with ${JSON.stringify(MESSAGE_REFERENCE_PREFIX)}`;
		}
	}

	return undefined;
}

/** Schema reference prefixes: session references use `ses`, message references `msg_`. */
const SESSION_REFERENCE_PREFIX = "ses";
const MESSAGE_REFERENCE_PREFIX = "msg_";
