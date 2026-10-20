import { isRecord } from "@/shared/api";

export type DeviceGrant = {
	id: string;
	deviceID: string;
	createdAt: string;
	expiresAt: string;
	lastSeenAt: string | null;
	revokedAt: string | null;
	status: "active" | "revoked";
};

export function parseGrants(value: unknown): DeviceGrant[] | null {
	if (!isRecord(value) || !Array.isArray(value.grants)) return null;
	const grants = value.grants.map(parseGrant);
	return grants.some((grant) => grant === null) ? null : (grants as DeviceGrant[]);
}

function parseGrant(value: unknown): DeviceGrant | null {
	if (!isRecord(value)) return null;
	const { id, deviceID, createdAt, expiresAt, lastSeenAt, revokedAt, status } = value;
	if (
		typeof id !== "string" ||
		typeof deviceID !== "string" ||
		deviceID.length === 0 ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(createdAt)) ||
		typeof expiresAt !== "string" ||
		!Number.isFinite(Date.parse(expiresAt)) ||
		!(lastSeenAt === null || (typeof lastSeenAt === "string" && Number.isFinite(Date.parse(lastSeenAt)))) ||
		!(revokedAt === null || (typeof revokedAt === "string" && Number.isFinite(Date.parse(revokedAt)))) ||
		(status !== "active" && status !== "revoked")
	) {
		return null;
	}
	return {
		id,
		deviceID,
		createdAt,
		expiresAt,
		lastSeenAt,
		revokedAt,
		status,
	};
}
