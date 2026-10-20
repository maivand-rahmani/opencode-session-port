import { requestJson, type ApiResult } from "@/shared/api";

export function signOutBrowser(): Promise<ApiResult> {
	return requestJson("/api/auth/sign-out", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
}
