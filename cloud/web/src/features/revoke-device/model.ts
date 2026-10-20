import { isRecord } from "@/shared/api";

export function parseRevokeStatus(value: unknown): boolean {
	return isRecord(value) && value.status === "revoked";
}
