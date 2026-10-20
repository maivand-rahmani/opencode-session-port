import { requestJson, type ApiResult } from "@/shared/api";

export function fetchBrowserSession(): Promise<ApiResult> {
	return requestJson("/api/native/v1/session");
}
