/**
 * Portable SessionPort lineage metadata.
 *
 * OpenCode's supported import API preserves `info.metadata` but rejects an
 * existing session ID, so a copy may legitimately live under a derived session
 * ID. Lineage is the only portable link between such a copy and its original:
 *
 *   info.metadata.sessionport = { version: 1, lineageID: "<stable id>" }
 *
 * Rules:
 * - A valid stamp is preserved exactly; SessionPort never rewrites an existing
 *   valid lineage.
 * - A record without a stamp resolves to its own session ID, so the first
 *   import of an unstamped session and the original on the other machine share
 *   a lineage without requiring any host-database write.
 * - Invalid/absent metadata is treated as "no lineage" rather than an error;
 *   unrelated metadata keys are never interpreted or removed.
 * - The stamp is identity metadata, not session content; the normalized content
 *   fingerprint excludes it.
 */

import type { JsonObject, SessionRecord } from "../contracts/index.ts";
import { isJsonObject } from "../sessions/guards.ts";

/** Opaque metadata namespace owned by SessionPort. */
export const SESSIONPORT_METADATA_KEY = "sessionport";

/** Current lineage stamp version. */
export const SESSIONPORT_LINEAGE_VERSION = 1;

/**
 * Conservative portable identifier shape: a leading alphanumeric, then
 * alphanumerics plus `.`, `_`, `:`, `-`; at most 128 characters. Session IDs
 * (`ses_...`) fit comfortably.
 */
const LINEAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Valid lineage ID carried by `info.metadata.sessionport`, if any. */
export function readLineageID(info: JsonObject): string | undefined {
	const metadata = info["metadata"];
	if (!isJsonObject(metadata)) return undefined;
	const stamp = metadata[SESSIONPORT_METADATA_KEY];
	if (!isJsonObject(stamp)) return undefined;
	if (stamp["version"] !== SESSIONPORT_LINEAGE_VERSION) return undefined;
	const lineageID = stamp["lineageID"];
	if (typeof lineageID !== "string" || !LINEAGE_ID_PATTERN.test(lineageID)) return undefined;
	return lineageID;
}

/**
 * The lineage a record belongs to: its valid stamp, or its own session ID for
 * legacy/unstamped records. Never returns an empty value for a valid record.
 */
export function sessionLineageID(record: SessionRecord): string {
	const stamped = readLineageID(record.info);
	if (stamped !== undefined) return stamped;
	const id = record.info["id"];
	return typeof id === "string" ? id : "";
}

/**
 * Returns a detached copy of `record` carrying `lineageID` when the record has
 * no valid stamp yet. Existing valid stamps win; invalid or non-object metadata
 * is preserved untouched so opaque host data is never silently replaced.
 */
export function stampSessionLineage(record: SessionRecord, lineageID: string): SessionRecord {
	if (!LINEAGE_ID_PATTERN.test(lineageID)) return cloneRecord(record);
	if (readLineageID(record.info) !== undefined) return cloneRecord(record);

	const metadata = record.info["metadata"];
	if (metadata !== undefined && metadata !== null && !isJsonObject(metadata)) {
		return cloneRecord(record);
	}
	const copy = cloneRecord(record);
	const existing = copy.info["metadata"];
	const nextMetadata: { [key: string]: unknown } = isJsonObject(existing) ? { ...existing } : {};
	nextMetadata[SESSIONPORT_METADATA_KEY] = {
		version: SESSIONPORT_LINEAGE_VERSION,
		lineageID,
	};
	(copy.info as { [key: string]: unknown })["metadata"] = nextMetadata;
	return copy;
}

function cloneRecord(record: SessionRecord): SessionRecord {
	return JSON.parse(JSON.stringify(record)) as SessionRecord;
}
