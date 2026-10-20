import { proxyNativePost } from "@/_app/server/index.server";

export async function POST(request: Request): Promise<Response> {
	return proxyNativePost(request, "approve");
}
