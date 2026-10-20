import { apiErrorResponse, proxyNativeGet } from "@/_app/server/index.server";

export async function GET(request: Request): Promise<Response> {
	return proxyNativeGet(request, "session");
}

export async function HEAD(_request: Request): Promise<Response> {
	return apiErrorResponse(404, "not-found");
}
