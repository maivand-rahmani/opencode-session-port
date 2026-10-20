/**
 * Deterministic, header-only assembler for the vendor-generated Better Auth
 * Prisma schema (`cloud/api/prisma/auth.generated.prisma`).
 *
 * WHAT THIS DOES
 * - Verifies the exact reviewed vendor prefix, including the single
 *   `generator client` block, its `prisma-client` provider, and the single
 *   `datasource db` block with the `postgresql` provider.
 * - Replaces only the known initial generator block with the same generator
 *   plus an explicit relative `output`, `moduleFormat = "esm"`, and
 *   `importFileExtension = "js"`.
 * - Appends the remainder of the vendor file from its original bytes, so the
 *   datasource block and every model byte stay identical.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * - It does not parse, format, merge, or rewrite models, fields, relations,
 *   indexes, datasource URLs, or duplicate blocks. It is not a Prisma parser.
 * - It does not write files, install packages, invoke a CLI, connect to a
 *   database, or generate a client. The caller owns file placement.
 * - It does not repair drifted input. Every unexpected shape fails closed.
 *
 * API
 *   assembleAuthSchema(vendorBytesOrText, clientOutput) -> Buffer
 *   validateClientOutput(clientOutput) -> string
 *
 * Error instances are `AuthSchemaAssemblyError` with a stable `code`:
 *   VENDOR_INPUT_TYPE, VENDOR_UTF8_INVALID, VENDOR_HEADER_DRIFT,
 *   VENDOR_GENERATOR_MISSING, VENDOR_GENERATOR_DUPLICATE,
 *   VENDOR_DATASOURCE_MISSING, VENDOR_DATASOURCE_DUPLICATE,
 *   CLIENT_OUTPUT_INVALID
 */

import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

/**
 * Exact reviewed vendor prefix through the generator close. The vendor file
 * has mixed line endings; preserving them is intentional and part of the
 * drift check.
 */
const VENDOR_GENERATOR_BLOCK =
	'\ngenerator client {\n  provider = "prisma-client"\n}\r\n';

/** Exact reviewed datasource block, kept in the assembled output untouched. */
const VENDOR_DATASOURCE_BLOCK =
	'\r\ndatasource db {\n  provider = "postgresql"\n}\r\n\n';

const VENDOR_HEADER = VENDOR_GENERATOR_BLOCK + VENDOR_DATASOURCE_BLOCK;

const GENERATOR_DECLARATION = /\bgenerator[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\{/g;
const DATASOURCE_DECLARATION = /\bdatasource[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\{/g;

const MAX_CLIENT_OUTPUT_LENGTH = 240;
const MAX_CLIENT_OUTPUT_SEGMENTS = 16;
const SAFE_OUTPUT_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export class AuthSchemaAssemblyError extends Error {
	/**
	 * @param {string} code stable fail-closed category
	 * @param {string} message human-readable detail; never includes secrets
	 */
	constructor(code, message) {
		super(message);
		this.name = "AuthSchemaAssemblyError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new AuthSchemaAssemblyError(code, message);
}

function countMatches(text, pattern) {
	const expression = new RegExp(pattern.source, pattern.flags);
	return [...text.matchAll(expression)].length;
}

function requireSingleDeclaration(text, pattern, kind, missingCode, duplicateCode) {
	const count = countMatches(text, pattern);
	if (count === 0) {
		fail(missingCode, `vendor schema is missing its single ${kind} block`);
	}
	if (count > 1) {
		fail(duplicateCode, `vendor schema contains ${count} ${kind} blocks; exactly one is required`);
	}
}

function toVendorBytes(vendor) {
	if (typeof vendor === "string") {
		return Buffer.from(vendor, "utf8");
	}
	if (vendor instanceof Uint8Array) {
		// Copy so later caller mutation cannot affect the result or checks.
		return Buffer.from(vendor);
	}
	fail("VENDOR_INPUT_TYPE", "vendor input must be a string, Buffer, or Uint8Array");
}

/**
 * Validates the explicit client output directory. It must be a relative,
 * printable-ASCII, forward-slash path with no empty, `.` or `..` segments.
 * This rejects absolute paths, drive letters, quotes, control characters,
 * backslashes, and traversal sequences before they can enter the schema text.
 *
 * @param {string} clientOutput
 * @returns {string} the validated path
 */
export function validateClientOutput(clientOutput) {
	if (typeof clientOutput !== "string" || clientOutput.length === 0) {
		fail("CLIENT_OUTPUT_INVALID", "clientOutput must be a non-empty string");
	}
	if (clientOutput.length > MAX_CLIENT_OUTPUT_LENGTH) {
		fail(
			"CLIENT_OUTPUT_INVALID",
			`clientOutput must be at most ${MAX_CLIENT_OUTPUT_LENGTH} characters`,
		);
	}
	if (!/^[\x21-\x7e]+$/.test(clientOutput)) {
		fail("CLIENT_OUTPUT_INVALID", "clientOutput must contain only printable ASCII without spaces");
	}
	if (clientOutput.includes("\\")) {
		fail("CLIENT_OUTPUT_INVALID", "clientOutput must use forward slashes, not backslashes");
	}
	if (clientOutput.startsWith("/") || clientOutput.endsWith("/") || clientOutput.includes("//")) {
		fail("CLIENT_OUTPUT_INVALID", "clientOutput must be a non-empty relative path without empty segments");
	}
	const segments = clientOutput.split("/");
	if (segments.length > MAX_CLIENT_OUTPUT_SEGMENTS) {
		fail(
			"CLIENT_OUTPUT_INVALID",
			`clientOutput must contain at most ${MAX_CLIENT_OUTPUT_SEGMENTS} path segments`,
		);
	}
	for (const segment of segments) {
		if (!SAFE_OUTPUT_SEGMENT.test(segment)) {
			fail("CLIENT_OUTPUT_INVALID", "clientOutput contains an unsafe path segment");
		}
	}
	return clientOutput;
}

/**
 * Produces the derived, single-file Prisma schema.
 *
 * The returned Buffer contains the new generator block followed by the
 * original vendor bytes starting exactly after the original generator block.
 * No model or datasource byte is decoded and re-encoded on that path.
 *
 * @param {string | Uint8Array} vendorBytesOrText exact vendor schema bytes/text
 * @param {string} clientOutput relative generated-client output directory
 * @returns {Buffer} derived schema bytes
 */
export function assembleAuthSchema(vendorBytesOrText, clientOutput) {
	const safeClientOutput = validateClientOutput(clientOutput);
	const vendorBytes = toVendorBytes(vendorBytesOrText);

	try {
		new TextDecoder("utf-8", { fatal: true }).decode(vendorBytes);
	} catch {
		fail("VENDOR_UTF8_INVALID", "vendor schema input is not valid UTF-8");
	}

	const vendorText = vendorBytes.toString("utf8");

	// Header-only declaration count. This catches missing or extra blocks
	// anywhere in the schema without attempting to parse model content.
	requireSingleDeclaration(
		vendorText,
		GENERATOR_DECLARATION,
		"generator",
		"VENDOR_GENERATOR_MISSING",
		"VENDOR_GENERATOR_DUPLICATE",
	);
	requireSingleDeclaration(
		vendorText,
		DATASOURCE_DECLARATION,
		"datasource",
		"VENDOR_DATASOURCE_MISSING",
		"VENDOR_DATASOURCE_DUPLICATE",
	);

	// Header authenticity: exact bytes, exact providers, no leading content.
	if (!vendorText.startsWith(VENDOR_HEADER)) {
		fail(
			"VENDOR_HEADER_DRIFT",
			"vendor schema does not start with the exact reviewed generator/datasource header",
		);
	}

	const replacementGenerator =
		'\ngenerator client {\n' +
		'  provider = "prisma-client"\n' +
		`  output   = "${safeClientOutput}"\n` +
		'  moduleFormat = "esm"\n' +
		'  importFileExtension = "js"\n' +
		'}\r\n';

	const generatorBlockBytes = Buffer.byteLength(VENDOR_GENERATOR_BLOCK, "utf8");
	const originalRemainder = vendorBytes.subarray(generatorBlockBytes);
	const replacementBytes = Buffer.from(replacementGenerator, "utf8");

	return Buffer.concat([replacementBytes, originalRemainder]);
}
