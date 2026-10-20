import { NextResponse, type NextRequest } from "next/server";

export function securityProxy(request: NextRequest) {
	const nonce = btoa(crypto.randomUUID());
	const developmentConnect = process.env.NODE_ENV === "development"
		? " ws://localhost:* ws://127.0.0.1:*"
		: "";
	const policy = [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'`,
		`style-src 'self' 'nonce-${nonce}'`,
		"style-src-attr 'none'",
		"script-src-attr 'none'",
		"img-src 'self'",
		"font-src 'self'",
		"frame-src 'none'",
		`connect-src 'self'${developmentConnect}`,
		"base-uri 'none'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
	].join("; ");

	const requestHeaders = new Headers(request.headers);
	requestHeaders.set("x-nonce", nonce);
	requestHeaders.set("Content-Security-Policy", policy);

	const response = NextResponse.next({ request: { headers: requestHeaders } });
	response.headers.set("Content-Security-Policy", policy);
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("Referrer-Policy", "no-referrer");
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set("X-Frame-Options", "DENY");
	response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	return response;
}
