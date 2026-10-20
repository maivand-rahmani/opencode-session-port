import { apiErrorResponse, proxyAuthRequest } from "@/_app/server/index.server";

type RouteContext = { params: Promise<{ auth: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
	const { auth } = await context.params;
	return proxyAuthRequest(request, auth);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
	const { auth } = await context.params;
	return proxyAuthRequest(request, auth);
}

export async function HEAD(_request: Request): Promise<Response> {
	return apiErrorResponse(404, "not-found");
}
