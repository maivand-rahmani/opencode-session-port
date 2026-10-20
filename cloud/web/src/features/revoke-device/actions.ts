import { requestJson, type ApiResult } from "@/shared/api";

export function revokeDevice(grantID: string, csrfToken: string): Promise<ApiResult> {
	return requestJson(`/api/native/v1/grants/${encodeURIComponent(grantID)}/revoke`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-sessionport-csrf": csrfToken,
		},
		body: "{}",
	});
}
