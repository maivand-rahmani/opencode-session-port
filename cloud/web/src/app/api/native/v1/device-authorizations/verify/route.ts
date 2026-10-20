import { apiErrorResponse, proxyNativePost, redirectToCanonicalDevice } from "@/_app/server/index.server";

export async function GET(_request: Request): Promise<Response> {
	// Native clients open this fixed verification URI. Never forward query values
	// such as a human code; the user enters that code on the /device page.
	return redirectToCanonicalDevice();
}

export async function POST(request: Request): Promise<Response> {
	return proxyNativePost(request, "verify");
}

export async function HEAD(_request: Request): Promise<Response> {
	return apiErrorResponse(404, "not-found");
}
