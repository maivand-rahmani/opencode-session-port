import type { NextRequest } from "next/server";
import { securityProxy } from "@/_app/security/index.server";

export function proxy(request: NextRequest) {
	return securityProxy(request);
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
