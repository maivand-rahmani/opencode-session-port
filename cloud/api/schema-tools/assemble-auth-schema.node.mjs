#!/usr/bin/env node
/**
 * Focused Node unit tests for the deterministic auth-schema assembler.
 *
 * Run explicitly (root `bun test` and the API `.node.ts` runner do not match
 * this filename):
 *   node --test cloud/api/schema-tools/assemble-auth-schema.node.mjs
 *
 * These tests are offline. They read the reviewed vendor artifact, assemble in
 * memory, and never write files, start a database, or invoke a CLI.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assembleAuthSchema,
	AuthSchemaAssemblyError,
	validateClientOutput,
} from "./assemble-auth-schema.mjs";

const VENDOR_PATH = fileURLToPath(new URL("../prisma/auth.generated.prisma", import.meta.url));
const VENDOR_BYTES = readFileSync(VENDOR_PATH);
const VENDOR_TEXT = VENDOR_BYTES.toString("utf8");
const VENDOR_BYTES_LENGTH = 9533;
const VENDOR_SHA256 = "092B8D645B8E2FD9448FF93EA8EED3B76C75BD1696D250AF70E137141AD0AE5C";
const CLIENT_OUTPUT = "generated/prisma-client";
const ASSEMBLED_SHA256 = "ADBACD735437417F87232C3BAE1A10A6C89B53FE918E4AA3ABF87D4CFD544BDF";

const EXPECTED_GENERATOR =
	'\ngenerator client {\n' +
	'  provider = "prisma-client"\n' +
	`  output   = "${CLIENT_OUTPUT}"\n` +
	'  moduleFormat = "esm"\n' +
	'  importFileExtension = "js"\n' +
	"}\r\n";

const DATASOURCE_MARKER = Buffer.from("\r\ndatasource db {");
const MODEL_MARKER = Buffer.from("\nmodel User {");

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function expectCode(code, callback) {
	assert.throws(callback, (error) => {
		assert.ok(error instanceof AuthSchemaAssemblyError, "expected AuthSchemaAssemblyError");
		assert.equal(error.code, code);
		return true;
	});
}

test("reviewed vendor artifact is byte-for-byte unchanged", () => {
	assert.equal(VENDOR_BYTES.length, VENDOR_BYTES_LENGTH);
	assert.equal(sha256(VENDOR_BYTES), VENDOR_SHA256);
	assert.ok(!(VENDOR_BYTES[0] === 0xef && VENDOR_BYTES[1] === 0xbb && VENDOR_BYTES[2] === 0xbf));
});

test("assembles the exact expected header without rewriting the tail", () => {
	const assembled = assembleAuthSchema(VENDOR_BYTES, CLIENT_OUTPUT);
	const assembledText = assembled.toString("utf8");

	assert.equal(
		assembled.subarray(0, Buffer.byteLength(EXPECTED_GENERATOR)).toString("utf8"),
		EXPECTED_GENERATOR,
	);
	assert.equal(sha256(assembled), ASSEMBLED_SHA256);

	const vendorDatasourceIndex = VENDOR_BYTES.indexOf(DATASOURCE_MARKER);
	const assembledDatasourceIndex = assembled.indexOf(DATASOURCE_MARKER);
	assert.ok(vendorDatasourceIndex > 0, "vendor datasource marker must exist");
	assert.ok(assembledDatasourceIndex > 0, "assembled datasource marker must exist");

	// Datasource block plus every model byte must remain identical.
	assert.deepEqual(
		assembled.subarray(assembledDatasourceIndex),
		VENDOR_BYTES.subarray(vendorDatasourceIndex),
	);

	const vendorModelIndex = VENDOR_BYTES.indexOf(MODEL_MARKER);
	const assembledModelIndex = assembled.indexOf(MODEL_MARKER);
	assert.ok(vendorModelIndex > 0, "vendor model marker must exist");
	assert.deepEqual(
		assembled.subarray(assembledModelIndex),
		VENDOR_BYTES.subarray(vendorModelIndex),
	);

	// Exactly one header block of each kind, no duplicate wrapper.
	assert.equal((assembledText.match(/^generator\s+\w+\s*\{/gm) ?? []).length, 1);
	assert.equal((assembledText.match(/^datasource\s+\w+\s*\{/gm) ?? []).length, 1);
	assert.equal((assembledText.match(/^model\s+\w+\s*\{/gm) ?? []).length, 13);
	assert.doesNotMatch(assembledText, /provider\s*=\s*"prisma-client-js"/);
	assert.match(
		assembledText,
		/  output   = "generated\/prisma-client"\r?\n  moduleFormat = "esm"\r?\n  importFileExtension = "js"\r?\n\}/,
	);

	// No business model was invented by assembly.
	for (const forbidden of [
		"model Device {",
		"model DeviceGrant {",
		"model Project {",
		"model Revision {",
		"model Upload {",
		"model AccountKeyBundle {",
		"model UserQuota {",
	]) {
		assert.equal(assembledText.includes(forbidden), false, `unexpected ${forbidden}`);
	}
});

test("is deterministic across byte input, text input, and repeated calls", () => {
	const first = assembleAuthSchema(VENDOR_BYTES, CLIENT_OUTPUT);
	const second = assembleAuthSchema(VENDOR_BYTES, CLIENT_OUTPUT);
	const fromText = assembleAuthSchema(VENDOR_TEXT, CLIENT_OUTPUT);
	const copiedInput = Uint8Array.from(VENDOR_BYTES);
	const fromUint8Array = assembleAuthSchema(copiedInput, CLIENT_OUTPUT);

	assert.deepEqual(second, first);
	assert.deepEqual(fromText, first);
	assert.deepEqual(fromUint8Array, first);
	assert.equal(sha256(first), ASSEMBLED_SHA256);
	assert.equal(sha256(second), ASSEMBLED_SHA256);
});

test("fails closed on header and provider drift", () => {
	expectCode("VENDOR_HEADER_DRIFT", () =>
		assembleAuthSchema(VENDOR_TEXT.slice(1), CLIENT_OUTPUT),
	);
	expectCode("VENDOR_HEADER_DRIFT", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace('provider = "prisma-client"', 'provider = "prisma-client-js"'),
			CLIENT_OUTPUT,
		),
	);
	expectCode("VENDOR_HEADER_DRIFT", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace('provider = "postgresql"', 'provider = "mysql"'),
			CLIENT_OUTPUT,
		),
	);
	expectCode("VENDOR_HEADER_DRIFT", () =>
		assembleAuthSchema(`// leading comment\n${VENDOR_TEXT}`, CLIENT_OUTPUT),
	);
	expectCode("VENDOR_HEADER_DRIFT", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace(
				'  provider = "prisma-client"\n',
				'  provider = "prisma-client"\n  previewFeatures = ["driverAdapters"]\n',
			),
			CLIENT_OUTPUT,
		),
	);
});

test("fails closed on missing or duplicate generator and datasource blocks", () => {
	expectCode("VENDOR_GENERATOR_MISSING", () => assembleAuthSchema("", CLIENT_OUTPUT));
	expectCode("VENDOR_GENERATOR_MISSING", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace(/\ngenerator client \{[\s\S]*?\r\n/, "\r\n"),
			CLIENT_OUTPUT,
		),
	);
	expectCode("VENDOR_DATASOURCE_MISSING", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace(/\r\ndatasource db \{[\s\S]*?\}\r\n\n/, "\n"),
			CLIENT_OUTPUT,
		),
	);
	expectCode("VENDOR_GENERATOR_DUPLICATE", () =>
		assembleAuthSchema(
			VENDOR_TEXT.replace(
				"\nmodel User {",
				'\ngenerator second {\n  provider = "prisma-client"\n}\n\nmodel User {',
			),
			CLIENT_OUTPUT,
		),
	);
	expectCode("VENDOR_DATASOURCE_DUPLICATE", () =>
		assembleAuthSchema(
			`${VENDOR_TEXT}\ndatasource second {\n  provider = "postgresql"\n}\n`,
			CLIENT_OUTPUT,
		),
	);
});

test("rejects malformed vendor input types and invalid UTF-8", () => {
	expectCode("VENDOR_INPUT_TYPE", () => assembleAuthSchema(null, CLIENT_OUTPUT));
	expectCode("VENDOR_INPUT_TYPE", () => assembleAuthSchema(42, CLIENT_OUTPUT));
	expectCode("VENDOR_INPUT_TYPE", () => assembleAuthSchema({}, CLIENT_OUTPUT));

	const invalidUtf8 = Buffer.from(VENDOR_BYTES);
	invalidUtf8[invalidUtf8.length - 1] = 0xff;
	expectCode("VENDOR_UTF8_INVALID", () => assembleAuthSchema(invalidUtf8, CLIENT_OUTPUT));
});

test("accepts only safe explicit relative client output paths", () => {
	for (const accepted of [
		"client",
		"generated/prisma-client",
		"generated/auth_client.v2",
		"A_b-c.d/e1/f",
	]) {
		assert.equal(validateClientOutput(accepted), accepted);
		assert.ok(assembleAuthSchema(VENDOR_BYTES, accepted).length > VENDOR_BYTES.length);
	}

	for (const rejected of [
		"",
		".",
		"..",
		"../escape",
		"generated/../../escape",
		"generated/./client",
		"/absolute",
		"\\absolute",
		"generated\\client",
		"C:/absolute",
		"C:relative",
		"generated//client",
		"generated/",
		"generated/client/",
		".hidden/client",
		"generated/ client",
		'generated/"client"',
		"generated/client\ninjected",
		"generated/client\rinjected",
		"generated/client\tinjected",
		"generated/client\u0000injected",
		"generated/ümlaut",
		`${"a".repeat(250)}`,
		`${"a/".repeat(17)}client`,
	]) {
		expectCode("CLIENT_OUTPUT_INVALID", () => validateClientOutput(rejected));
		expectCode("CLIENT_OUTPUT_INVALID", () =>
			assembleAuthSchema(VENDOR_BYTES, rejected),
		);
	}
});

test("rejects non-string client output rather than coercing it", () => {
	for (const rejected of [undefined, null, 0, 1, true, false, {}, [], ["generated/client"]]) {
		expectCode("CLIENT_OUTPUT_INVALID", () => validateClientOutput(rejected));
	}
});
