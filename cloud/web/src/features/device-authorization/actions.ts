import { requestJson, type ApiResult } from "@/shared/api";

export function verifyDeviceAuthorization(userCode: string, csrfToken: string): Promise<ApiResult> {
	return requestJson("/api/native/v1/device-authorizations/verify", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-sessionport-csrf": csrfToken,
		},
		body: JSON.stringify({ userCode }),
	});
}

export function decideDeviceAuthorization(
	decision: "approve" | "deny",
	userCode: string,
	csrfToken: string,
): Promise<ApiResult> {
	const route = decision === "approve" ? "approve" : "deny";
	return requestJson(`/api/native/v1/device-authorizations/${route}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-sessionport-csrf": csrfToken,
		},
		body: JSON.stringify(decision === "approve" ? { userCode, confirm: true } : { userCode }),
	});
}
