import { requestJson, type ApiResult } from "@/shared/api";

export function fetchDeviceGrants(): Promise<ApiResult> {
	return requestJson("/api/native/v1/grants");
}
