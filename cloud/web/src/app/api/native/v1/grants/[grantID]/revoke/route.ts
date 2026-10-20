import { proxyNativePost } from "@/_app/server/index.server";

type RouteContext = { params: Promise<{ grantID: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
	const { grantID } = await context.params;
	return proxyNativePost(request, "revoke", { grantID });
}
