import { apiErrorResponse } from "@/_app/server/index.server";

function rejected(_request: Request): Response {
	return apiErrorResponse(404, "not-found");
}

export const GET = rejected;
export const POST = rejected;
export const PUT = rejected;
export const PATCH = rejected;
export const DELETE = rejected;
export const HEAD = rejected;
export const OPTIONS = rejected;
