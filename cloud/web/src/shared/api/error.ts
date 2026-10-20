import { isRecord } from "./http";

export function apiErrorMessage(value: unknown, fallback: string): string {
	if (!isRecord(value) || !isRecord(value.error)) return fallback;
	const error = value.error;
	const knownCode = new Set([
		"invalid-json",
		"payload-too-large",
		"unsupported-media-type",
		"invalid-request",
		"unauthenticated",
		"not-found",
		"unavailable",
		"internal-error",
	]);
	if (
		typeof error.code !== "string" ||
		!knownCode.has(error.code) ||
		typeof error.message !== "string" ||
		typeof error.retryable !== "boolean" ||
		typeof error.requestID !== "string"
	) {
		return fallback;
	}
	return error.message;
}

export function apiErrorCode(value: unknown): string | null {
	if (!isRecord(value) || !isRecord(value.error) || typeof value.error.code !== "string") return null;
	return value.error.code;
}
