/**
 * Pure SQL-text builder for a single-session psql validation of reviewed
 * Prisma-generated PostgreSQL DDL.
 *
 * WHAT THIS DOES
 * - `buildValidationSql({ draftSql, expectedSha256, expectedTables })` verifies
 *   the exact draft bytes against a caller-supplied SHA-256, applies a narrow
 *   fail-closed statement allowlist for the known Prisma DDL shape, and returns
 *   one SQL text intended for psql standard input.
 * - The returned text starts a transaction with bounded timeouts, runs a guard
 *   that checks the exact validation database/role, PostgreSQL major version,
 *   writable transaction state, the public-only schema shape, and emptiness of
 *   public. It then executes the draft, checks the expected base-table set and
 *   primary keys, emits a fixed success row, rolls back, verifies emptiness in
 *   a second transaction, and emits a fixed rollback-verified row.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * - It does not execute SQL, connect to PostgreSQL, read credentials or
 *   environment files, spawn a process, write files, use the network, or print
 *   secrets. The caller owns the psql invocation and credentials.
 * - It is not a SQL parser, a general SQL sanitizer, or a proof that the draft
 *   is safe. The draft must be independently reviewed and SHA-256 pinned. The
 *   lexical checks below are a narrow pre-filter, not an authorization to run
 *   arbitrary SQL. A hash mismatch or any unexpected shape fails closed.
 * - It does not retry, clean up, or issue DROP. Any psql error must be handled
 *   by `ON_ERROR_STOP=1` and session disconnect (which rolls back the open
 *   transaction). The caller must then verify emptiness in a fresh session.
 * - It does not verify host, port, tunnel, TLS, credential source, or network
 *   path. The caller/server agent owns the psql invocation and connection.
 * - It does not claim PostgreSQL 16 runtime compatibility. The PG-major and
 *   target-identity checks are runtime assertions, not evidence from this
 *   offline module/test pair.
 *
 * DRAFT SCANNER LIMITS
 * - Supports only the known Prisma DDL statement shapes: exactly
 *   `CREATE SCHEMA IF NOT EXISTS public`, `CREATE TABLE [IF NOT EXISTS]`,
 *   `CREATE [UNIQUE] INDEX [IF NOT EXISTS]`, and
 *   `ALTER TABLE ... ADD CONSTRAINT ...` with PRIMARY KEY, UNIQUE, FOREIGN KEY,
 *   or CHECK constraints. Everything else is rejected.
 * - Requires a semicolon after every statement and rejects empty statements.
 * - Every relation named by CREATE TABLE, CREATE INDEX, ALTER TABLE, or a
 *   REFERENCES clause must appear in expectedTables. Schema-qualified relation
 *   names are rejected.
 * - expectedTables are exact PostgreSQL catalog names (`pg_class.relname`), not
 *   Prisma model names; for vendor tables they are the lowercase `@@map`
 *   values such as `user` and `oauthClient`.
 * - The wrapper always asserts that public.user.id is text. expectedTables must
 *   include the vendor table `user` (the @@map of Prisma model User) for the
 *   runtime assertions to pass.
 * - Public indexes are checked only for belonging to an expected base table.
 *   Exact index names/counts and FK/unique counts are not asserted; those await
 *   the final reviewed schema.
 * - Handles single-quoted literals, double-quoted simple identifiers, line
 *   comments, and nested block comments. Any backslash, dollar quote, psql
 *   variable interpolation, control character, non-ASCII identifier, unquoted
 *   non-ASCII text, qualified relation name, or ambiguous construct is
 *   rejected conservatively.
 * - Rejects BEGIN/COMMIT/ROLLBACK text outside comments, including inside
 *   quoted literals, as an intentionally conservative transaction-control
 *   guard.
 * - The scanner is intentionally incomplete: it does not parse types,
 *   expressions, defaults, functions, or semantics. The reviewed hash remains
 *   the safety gate.
 *
 * Target constants are owner-reported validation target facts:
 * database `session_port_validation`, role `sessionport_validation_migrator`.
 * The application database `session_port` is never a target.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_EXPECTED_TABLES = 32;
const MAX_IDENTIFIER_BYTES = 63;

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const VALIDATION_DATABASE = "session_port_validation";
const VALIDATION_ROLE = "sessionport_validation_migrator";

/**
 * Words rejected anywhere in a CREATE TABLE body, including inside
 * parenthesized expressions. These would create or depend on sequences/identity
 * columns, which the vendor String-ID schema does not use.
 */
const TABLE_DISALLOWED_ANY_DEPTH = new Set([
	"bigserial",
	"currval",
	"generated",
	"identity",
	"nextval",
	"sequence",
	"serial",
	"setval",
	"smallserial",
]);

/**
 * Words rejected only at the top level of a CREATE TABLE body. Inside a CHECK
 * expression (depth > 0), words such as LIKE are ordinary expression syntax.
 */
const TABLE_DISALLOWED_TOP_LEVEL = new Set([
	"exclude",
	"inherits",
	"like",
	"oids",
	"partition",
	"tablespace",
	"temp",
	"temporary",
	"unlogged",
	"with",
	"without",
]);

const TRANSACTION_WORDS = ["begin", "commit", "rollback"];

export class ValidationSqlError extends Error {
	/**
	 * @param {string} code stable fail-closed category
	 * @param {string} message human-readable detail; never includes draft bytes or secrets
	 */
	constructor(code, message) {
		super(message);
		this.name = "ValidationSqlError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new ValidationSqlError(code, message);
}

function isWord(token, value) {
	return token !== undefined && token.type === "word" && token.lower === value;
}

function isIdentifier(token) {
	return (
		token !== undefined &&
		(token.type === "word" || token.type === "identifier")
	);
}

function isPunct(token, value) {
	return (
		token !== undefined && token.type === "punct" && token.value === value
	);
}

/** PostgreSQL folds unquoted identifiers to lowercase; quoted names are exact. */
function identifierName(token) {
	return token.type === "identifier" ? token.value : token.lower;
}

function sqlStringLiteral(value) {
	// expectedTables is restricted to a simple ASCII identifier alphabet, so it
	// cannot contain a single quote. Keep the escape defensive anyway.
	return `'${value.replaceAll("'", "''")}'`;
}

function toDraftBytesAndText(draftSql) {
	let bytes;
	if (typeof draftSql === "string") {
		bytes = Buffer.from(draftSql, "utf8");
	} else if (draftSql instanceof Uint8Array) {
		bytes = Buffer.from(draftSql);
	} else {
		fail("DRAFT_INPUT_TYPE", "draftSql must be a string, Buffer, or Uint8Array");
	}

	if (bytes.length > MAX_DRAFT_BYTES) {
		fail(
			"DRAFT_TOO_LARGE",
			`draftSql must be at most ${MAX_DRAFT_BYTES} UTF-8 bytes`,
		);
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		fail("DRAFT_BOM_UNSUPPORTED", "draftSql must not start with a UTF-8 BOM");
	}

	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		fail("DRAFT_UTF8_INVALID", "draftSql is not valid UTF-8");
	}

	if (typeof draftSql === "string" && text !== draftSql) {
		fail(
			"DRAFT_UTF8_INVALID",
			"draftSql contains an unpaired UTF-16 surrogate and cannot be re-encoded exactly",
		);
	}
	if (text.trim() === "") {
		fail("DRAFT_EMPTY", "draftSql must contain at least one SQL statement");
	}
	if (text.includes("\\")) {
		fail(
			"DRAFT_BACKSLASH",
			"draftSql must not contain a backslash (psql meta-command or escape input)",
		);
	}
	if (CONTROL_CHARACTER.test(text)) {
		fail(
			"DRAFT_CONTROL_CHARACTER",
			"draftSql must not contain unsupported control characters",
		);
	}

	return { bytes, text };
}

function validateExpectedHash(expectedSha256) {
	if (typeof expectedSha256 !== "string" || !SHA256_HEX.test(expectedSha256)) {
		fail(
			"EXPECTED_SHA256_INVALID",
			"expectedSha256 must be exactly 64 hexadecimal characters",
		);
	}
	return expectedSha256.toLowerCase();
}

function validateExpectedTables(expectedTables) {
	if (!Array.isArray(expectedTables)) {
		fail("EXPECTED_TABLES_INVALID", "expectedTables must be an array");
	}
	if (
		expectedTables.length === 0 ||
		expectedTables.length > MAX_EXPECTED_TABLES
	) {
		fail(
			"EXPECTED_TABLES_INVALID",
			`expectedTables must contain between 1 and ${MAX_EXPECTED_TABLES} names`,
		);
	}

	const seen = new Set();
	const result = [];
	for (const name of expectedTables) {
		if (
			typeof name !== "string" ||
			!SIMPLE_IDENTIFIER.test(name) ||
			Buffer.byteLength(name, "utf8") > MAX_IDENTIFIER_BYTES
		) {
			fail(
				"EXPECTED_TABLES_INVALID",
				"expectedTables names must be simple ASCII PostgreSQL identifiers of at most 63 bytes",
			);
		}
		if (name === "_prisma_migrations") {
			fail(
				"EXPECTED_TABLES_INVALID",
				"_prisma_migrations is required to be absent and cannot be expected",
			);
		}
		if (seen.has(name)) {
			fail("EXPECTED_TABLES_INVALID", "expectedTables names must be unique");
		}
		seen.add(name);
		result.push(name);
	}
	return result;
}

/**
 * Splits and lexically checks the draft. The returned statements are arrays of
 * tokens; no SQL is executed here.
 *
 * @param {string} text
 * @param {Set<string>} expectedTableSet
 */
function scanDraft(text, expectedTableSet) {
	const statements = [];
	let tokens = [];
	let visible = "";
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		// Line comments end at LF. PostgreSQL is the reference here; a lone CR
		// remains part of the comment rather than silently ending it.
		if (ch === "-" && text[i + 1] === "-") {
			visible += " ";
			i += 2;
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}

		if (ch === "/" && text[i + 1] === "*") {
			let depth = 1;
			i += 2;
			while (i < text.length && depth > 0) {
				if (text[i] === "/" && text[i + 1] === "*") {
					depth += 1;
					i += 2;
				} else if (text[i] === "*" && text[i + 1] === "/") {
					depth -= 1;
					i += 2;
				} else {
					i += 1;
				}
			}
			if (depth !== 0) {
				fail("DRAFT_UNTERMINATED_COMMENT", "draftSql contains an unterminated block comment");
			}
			visible += " ";
			continue;
		}

		if (ch === "'") {
			const start = i;
			i += 1;
			let closed = false;
			while (i < text.length) {
				if (text[i] === "'") {
					if (text[i + 1] === "'") {
						i += 2;
						continue;
					}
					i += 1;
					closed = true;
					break;
				}
				i += 1;
			}
			if (!closed) {
				fail("DRAFT_UNTERMINATED_STRING", "draftSql contains an unterminated string literal");
			}
			tokens.push({ type: "string" });
			visible += text.slice(start, i);
			continue;
		}

		if (ch === '"') {
			const start = i;
			i += 1;
			let closed = false;
			let content = "";
			while (i < text.length) {
				if (text[i] === '"') {
					if (text[i + 1] === '"') {
						content += '"';
						i += 2;
						continue;
					}
					i += 1;
					closed = true;
					break;
				}
				content += text[i];
				i += 1;
			}
			if (!closed) {
				fail(
					"DRAFT_UNTERMINATED_IDENTIFIER",
					"draftSql contains an unterminated quoted identifier",
				);
			}
			if (
				!SIMPLE_IDENTIFIER.test(content) ||
				Buffer.byteLength(content, "utf8") > MAX_IDENTIFIER_BYTES
			) {
				fail(
					"DRAFT_UNSUPPORTED_IDENTIFIER",
					"quoted identifiers must be simple ASCII PostgreSQL identifiers of at most 63 bytes",
				);
			}
			tokens.push({ type: "identifier", value: content });
			visible += text.slice(start, i);
			continue;
		}

		if (ch === "$") {
			fail(
				"DRAFT_DOLLAR_QUOTE",
				"draftSql must not contain dollar-quoted strings or parameters",
			);
		}

		if (ch === ":") {
			if (text[i + 1] === ":") {
				tokens.push({ type: "punct", value: "::" });
				visible += "::";
				i += 2;
				continue;
			}
			if (/[A-Za-z0-9_'"{]/.test(text[i + 1] ?? "")) {
				fail(
					"DRAFT_PSQL_VARIABLE",
					"draftSql must not contain psql variable interpolation",
				);
			}
			tokens.push({ type: "punct", value: ":" });
			visible += ":";
			i += 1;
			continue;
		}

		if (ch === ";") {
			if (tokens.length === 0) {
				fail("DRAFT_EMPTY_STATEMENT", "draftSql contains an empty statement");
			}
			statements.push(tokens);
			tokens = [];
			visible += ";";
			i += 1;
			continue;
		}

		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			visible += ch;
			i += 1;
			continue;
		}

		if (/[A-Za-z_]/.test(ch)) {
			const start = i;
			i += 1;
			while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i += 1;
			const value = text.slice(start, i);
			tokens.push({ type: "word", value, lower: value.toLowerCase() });
			visible += value;
			continue;
		}

		if (/[0-9]/.test(ch)) {
			const start = i;
			i += 1;
			while (i < text.length && /[0-9]/.test(text[i])) i += 1;
			const value = text.slice(start, i);
			tokens.push({ type: "number", value });
			visible += value;
			continue;
		}

		if (ch.charCodeAt(0) > 0x7e) {
			fail(
				"DRAFT_UNSUPPORTED_CHARACTER",
				"draftSql must not contain non-ASCII text outside quoted literals, quoted identifiers, or comments",
			);
		}

		tokens.push({ type: "punct", value: ch });
		visible += ch;
		i += 1;
	}

	if (tokens.length > 0) {
		fail(
			"DRAFT_UNTERMINATED_STATEMENT",
			"every draft statement must end with a semicolon",
		);
	}
	if (statements.length === 0) {
		fail("DRAFT_NO_STATEMENTS", "draftSql contains no SQL statements");
	}

	// Deliberately scans quoted literals/identifiers too, and deliberately
	// ignores comments. This is stricter than SQL transaction syntax on purpose.
	for (const word of TRANSACTION_WORDS) {
		if (new RegExp(`\\b${word}\\b`, "i").test(visible)) {
			fail(
				"DRAFT_TRANSACTION_CONTROL",
				`draftSql must not contain transaction keyword ${word.toUpperCase()} outside comments`,
			);
		}
	}

	for (const statement of statements) {
		validateStatement(statement, expectedTableSet);
	}

	return statements;
}

function findMatchingParen(tokens, openIndex) {
	if (!isPunct(tokens[openIndex], "(")) return -1;
	let depth = 0;
	for (let i = openIndex; i < tokens.length; i += 1) {
		if (isPunct(tokens[i], "(")) {
			depth += 1;
		} else if (isPunct(tokens[i], ")")) {
			depth -= 1;
			if (depth === 0) return i;
			if (depth < 0) return -1;
		}
	}
	return -1;
}

function requireNonEmptyGroup(tokens, openIndex, closeIndex, label) {
	if (closeIndex === openIndex + 1) {
		fail("DRAFT_STATEMENT_SHAPE", `${label} must not be empty`);
	}
}

function validateStatement(tokens, expectedTableSet) {
	if (isWord(tokens[0], "create")) {
		validateCreate(tokens, expectedTableSet);
		return;
	}
	if (isWord(tokens[0], "alter")) {
		validateAlter(tokens, expectedTableSet);
		return;
	}
	fail(
		"DRAFT_UNSUPPORTED_STATEMENT",
		"only reviewed CREATE SCHEMA/TABLE/INDEX and ALTER TABLE ADD CONSTRAINT statements are supported",
	);
}

function validateCreate(tokens, expectedTableSet) {
	if (isWord(tokens[1], "schema")) {
		validateCreateSchema(tokens);
		return;
	}
	if (isWord(tokens[1], "table")) {
		validateCreateTable(tokens, expectedTableSet);
		return;
	}
	if (isWord(tokens[1], "index")) {
		validateCreateIndex(tokens, 1, expectedTableSet);
		return;
	}
	if (isWord(tokens[1], "unique")) {
		validateCreateIndex(tokens, 2, expectedTableSet);
		return;
	}
	fail(
		"DRAFT_UNSUPPORTED_STATEMENT",
		"only CREATE SCHEMA, CREATE TABLE, CREATE [UNIQUE] INDEX, and ALTER TABLE ADD CONSTRAINT are supported",
	);
}

function validateCreateSchema(tokens) {
	if (
		tokens.length !== 6 ||
		!isWord(tokens[2], "if") ||
		!isWord(tokens[3], "not") ||
		!isWord(tokens[4], "exists") ||
		!isIdentifier(tokens[5]) ||
		identifierName(tokens[5]) !== "public"
	) {
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"the only supported schema statement is CREATE SCHEMA IF NOT EXISTS public",
		);
	}
}

function validateCreateTable(tokens, expectedTableSet) {
	let i = 2;
	if (isWord(tokens[i], "if")) {
		if (!isWord(tokens[i + 1], "not") || !isWord(tokens[i + 2], "exists")) {
			fail("DRAFT_STATEMENT_SHAPE", "malformed CREATE TABLE IF NOT EXISTS");
		}
		i += 3;
	}

	const name = tokens[i];
	if (!isIdentifier(name)) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE TABLE requires a simple unqualified table name");
	}
	if (isPunct(tokens[i + 1], ".")) {
		fail("DRAFT_STATEMENT_SHAPE", "schema-qualified table names are not supported");
	}
	if (!expectedTableSet.has(identifierName(name))) {
		fail(
			"DRAFT_TABLE_NOT_EXPECTED",
			"CREATE TABLE names a table that is not in expectedTables",
		);
	}
	i += 1;

	if (!isPunct(tokens[i], "(")) {
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"CREATE TABLE must be a parenthesized column-definition table, not AS/LIKE/PARTITION/OF",
		);
	}

	const close = findMatchingParen(tokens, i);
	if (close === -1) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE TABLE has unbalanced parentheses");
	}
	if (close === tokens.length - 1) {
		requireNonEmptyGroup(tokens, i, close, "CREATE TABLE column list");
	} else {
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"CREATE TABLE must not have trailing clauses such as WITH, INHERITS, PARTITION, or TABLESPACE",
		);
	}

	checkTableBody(tokens, i + 1, close, expectedTableSet);
}

function checkTableBody(tokens, start, end, expectedTableSet) {
	let depth = 0;
	for (let i = start; i < end; i += 1) {
		const token = tokens[i];
		if (token.type === "word") {
			if (TABLE_DISALLOWED_ANY_DEPTH.has(token.lower)) {
				fail(
					"DRAFT_UNSUPPORTED_STATEMENT",
					`CREATE TABLE uses unsupported sequence/identity feature ${token.value}`,
				);
			}
			if (depth === 0 && TABLE_DISALLOWED_TOP_LEVEL.has(token.lower)) {
				fail(
					"DRAFT_UNSUPPORTED_STATEMENT",
					`CREATE TABLE uses unsupported top-level table clause ${token.value}`,
				);
			}
			if (token.lower === "references") {
				const reference = tokens[i + 1];
				if (!isIdentifier(reference)) {
					fail("DRAFT_STATEMENT_SHAPE", "REFERENCES requires a simple table name");
				}
				if (isPunct(tokens[i + 2], ".")) {
					fail(
						"DRAFT_STATEMENT_SHAPE",
						"schema-qualified REFERENCES names are not supported",
					);
				}
				if (!expectedTableSet.has(identifierName(reference))) {
					fail(
						"DRAFT_TABLE_NOT_EXPECTED",
						"REFERENCES names a table that is not in expectedTables",
					);
				}
			}
		}
		if (isPunct(token, "(")) {
			depth += 1;
		} else if (isPunct(token, ")")) {
			depth -= 1;
		}
	}
	if (depth !== 0) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE TABLE has unbalanced nested parentheses");
	}
}

function validateCreateIndex(tokens, indexPosition, expectedTableSet) {
	let i = indexPosition;
	if (!isWord(tokens[i], "index")) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE UNIQUE must be CREATE UNIQUE INDEX");
	}
	i += 1;

	if (isWord(tokens[i], "concurrently")) {
		fail("DRAFT_UNSUPPORTED_STATEMENT", "CREATE INDEX CONCURRENTLY is not supported");
	}
	if (isWord(tokens[i], "if")) {
		if (!isWord(tokens[i + 1], "not") || !isWord(tokens[i + 2], "exists")) {
			fail("DRAFT_STATEMENT_SHAPE", "malformed CREATE INDEX IF NOT EXISTS");
		}
		i += 3;
	}

	const name = tokens[i];
	if (!isIdentifier(name)) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE INDEX requires a simple index name");
	}
	i += 1;
	if (!isWord(tokens[i], "on")) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE INDEX requires ON");
	}
	i += 1;

	const table = tokens[i];
	if (!isIdentifier(table)) {
		fail("DRAFT_STATEMENT_SHAPE", "CREATE INDEX requires a simple unqualified table name");
	}
	if (isPunct(tokens[i + 1], ".")) {
		fail("DRAFT_STATEMENT_SHAPE", "schema-qualified index targets are not supported");
	}
	if (!expectedTableSet.has(identifierName(table))) {
		fail(
			"DRAFT_TABLE_NOT_EXPECTED",
			"CREATE INDEX targets a table that is not in expectedTables",
		);
	}
	i += 1;
	if (!isPunct(tokens[i], "(")) {
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"CREATE INDEX must use a parenthesized column/expression list",
		);
	}

	const close = findMatchingParen(tokens, i);
	if (close === -1 || close !== tokens.length - 1) {
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"CREATE INDEX must not have trailing USING/INCLUDE/WHERE or unbalanced parentheses",
		);
	}
	requireNonEmptyGroup(tokens, i, close, "CREATE INDEX column/expression list");
}

function validateAlter(tokens, expectedTableSet) {
	if (!isWord(tokens[0], "alter") || !isWord(tokens[1], "table")) {
		fail(
			"DRAFT_UNSUPPORTED_STATEMENT",
			"only ALTER TABLE ... ADD CONSTRAINT is supported",
		);
	}

	let i = 2;
	const table = tokens[i];
	if (!isIdentifier(table)) {
		fail("DRAFT_STATEMENT_SHAPE", "ALTER TABLE requires a simple unqualified table name");
	}
	if (isPunct(tokens[i + 1], ".")) {
		fail("DRAFT_STATEMENT_SHAPE", "schema-qualified ALTER TABLE targets are not supported");
	}
	if (!expectedTableSet.has(identifierName(table))) {
		fail(
			"DRAFT_TABLE_NOT_EXPECTED",
			"ALTER TABLE targets a table that is not in expectedTables",
		);
	}
	i += 1;

	if (!isWord(tokens[i], "add") || !isWord(tokens[i + 1], "constraint")) {
		fail(
			"DRAFT_UNSUPPORTED_STATEMENT",
			"only ALTER TABLE ... ADD CONSTRAINT is supported; ADD COLUMN, DROP, RENAME, and ALTER COLUMN are rejected",
		);
	}
	i += 2;

	const constraintName = tokens[i];
	if (!isIdentifier(constraintName)) {
		fail("DRAFT_STATEMENT_SHAPE", "ADD CONSTRAINT requires a simple constraint name");
	}
	i += 1;

	if (isWord(tokens[i], "primary")) {
		if (!isWord(tokens[i + 1], "key")) {
			fail("DRAFT_STATEMENT_SHAPE", "PRIMARY must be PRIMARY KEY");
		}
		i += 2;
		const close = findMatchingParen(tokens, i);
		if (close === -1) {
			fail("DRAFT_STATEMENT_SHAPE", "PRIMARY KEY requires a parenthesized column list");
		}
		requireNonEmptyGroup(tokens, i, close, "PRIMARY KEY column list");
		if (close !== tokens.length - 1) {
			fail("DRAFT_STATEMENT_SHAPE", "PRIMARY KEY must not have trailing clauses");
		}
		return;
	}

	if (isWord(tokens[i], "unique")) {
		i += 1;
		const close = findMatchingParen(tokens, i);
		if (close === -1) {
			fail("DRAFT_STATEMENT_SHAPE", "UNIQUE requires a parenthesized column list");
		}
		requireNonEmptyGroup(tokens, i, close, "UNIQUE column list");
		if (close !== tokens.length - 1) {
			fail("DRAFT_STATEMENT_SHAPE", "UNIQUE must not have trailing clauses");
		}
		return;
	}

	if (isWord(tokens[i], "foreign")) {
		if (!isWord(tokens[i + 1], "key")) {
			fail("DRAFT_STATEMENT_SHAPE", "FOREIGN must be FOREIGN KEY");
		}
		i += 2;
		const localClose = findMatchingParen(tokens, i);
		if (localClose === -1) {
			fail("DRAFT_STATEMENT_SHAPE", "FOREIGN KEY requires a parenthesized column list");
		}
		requireNonEmptyGroup(tokens, i, localClose, "FOREIGN KEY column list");
		i = localClose + 1;

		if (!isWord(tokens[i], "references")) {
			fail("DRAFT_STATEMENT_SHAPE", "FOREIGN KEY requires REFERENCES");
		}
		i += 1;
		const reference = tokens[i];
		if (!isIdentifier(reference)) {
			fail("DRAFT_STATEMENT_SHAPE", "REFERENCES requires a simple table name");
		}
		if (isPunct(tokens[i + 1], ".")) {
			fail("DRAFT_STATEMENT_SHAPE", "schema-qualified REFERENCES names are not supported");
		}
		if (!expectedTableSet.has(identifierName(reference))) {
			fail(
				"DRAFT_TABLE_NOT_EXPECTED",
				"REFERENCES names a table that is not in expectedTables",
			);
		}
		i += 1;

		const remoteClose = findMatchingParen(tokens, i);
		if (remoteClose === -1) {
			fail(
				"DRAFT_STATEMENT_SHAPE",
				"FOREIGN KEY REFERENCES requires a parenthesized referenced-column list",
			);
		}
		requireNonEmptyGroup(tokens, i, remoteClose, "REFERENCES column list");
		i = remoteClose + 1;
		validateReferentialTail(tokens, i);
		return;
	}

	if (isWord(tokens[i], "check")) {
		i += 1;
		const close = findMatchingParen(tokens, i);
		if (close === -1) {
			fail("DRAFT_STATEMENT_SHAPE", "CHECK requires a parenthesized expression");
		}
		requireNonEmptyGroup(tokens, i, close, "CHECK expression");
		if (close !== tokens.length - 1) {
			fail("DRAFT_STATEMENT_SHAPE", "CHECK must not have trailing clauses");
		}
		return;
	}

	fail(
		"DRAFT_UNSUPPORTED_STATEMENT",
		"only ADD CONSTRAINT PRIMARY KEY, UNIQUE, FOREIGN KEY, or CHECK is supported",
	);
}

function validateReferentialTail(tokens, start) {
	let i = start;
	while (i < tokens.length) {
		if (isWord(tokens[i], "on")) {
			if (!isWord(tokens[i + 1], "delete") && !isWord(tokens[i + 1], "update")) {
				fail("DRAFT_STATEMENT_SHAPE", "ON must be followed by DELETE or UPDATE");
			}
			i += 2;
			if (isWord(tokens[i], "cascade") || isWord(tokens[i], "restrict")) {
				i += 1;
			} else if (isWord(tokens[i], "no") && isWord(tokens[i + 1], "action")) {
				i += 2;
			} else if (
				isWord(tokens[i], "set") &&
				(isWord(tokens[i + 1], "null") || isWord(tokens[i + 1], "default"))
			) {
				i += 2;
			} else {
				fail(
					"DRAFT_STATEMENT_SHAPE",
					"referential action must be CASCADE, RESTRICT, NO ACTION, SET NULL, or SET DEFAULT",
				);
			}
			continue;
		}
		if (isWord(tokens[i], "match")) {
			if (
				!isWord(tokens[i + 1], "full") &&
				!isWord(tokens[i + 1], "partial") &&
				!isWord(tokens[i + 1], "simple")
			) {
				fail("DRAFT_STATEMENT_SHAPE", "MATCH must be FULL, PARTIAL, or SIMPLE");
			}
			i += 2;
			continue;
		}
		if (isWord(tokens[i], "deferrable")) {
			i += 1;
			continue;
		}
		if (isWord(tokens[i], "not") && isWord(tokens[i + 1], "deferrable")) {
			i += 2;
			continue;
		}
		if (
			isWord(tokens[i], "initially") &&
			(isWord(tokens[i + 1], "deferred") || isWord(tokens[i + 1], "immediate"))
		) {
			i += 2;
			continue;
		}
		fail(
			"DRAFT_STATEMENT_SHAPE",
			"unsupported FOREIGN KEY tail; NOT VALID, extra ALTER actions, and unknown clauses are rejected",
		);
	}
}

function renderEmptyCheckBody() {
	return `  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: public schema is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname::text NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp')
      AND nspname::text !~ '^pg_temp_[0-9]+$'
      AND nspname::text !~ '^pg_toast_temp_[0-9]+$'
      AND nspname <> 'public'
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: unexpected non-system schema';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: public schema is not empty';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd', 'c', 'r', 'm')
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: public user-defined types exist';
  END IF;
  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'SessionPort validation refused: _prisma_migrations exists';
  END IF;
  SELECT count(*) INTO v_table_count
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF v_table_count <> 0 THEN
    RAISE EXCEPTION 'SessionPort validation refused: public base tables exist';
  END IF;`;
}

function renderEmptyAssertions(blockName) {
	return `DO $${blockName}$
DECLARE
  v_table_count integer;
BEGIN
${renderEmptyCheckBody()}
END
$${blockName}$;`;
}

function renderGuard() {
	return `DO $sessionport_guard$
DECLARE
  v_table_count integer;
BEGIN
  IF pg_catalog.current_database() <> '${VALIDATION_DATABASE}' THEN
    RAISE EXCEPTION 'SessionPort validation refused: unexpected database';
  END IF;
  IF current_user <> '${VALIDATION_ROLE}' OR session_user <> '${VALIDATION_ROLE}' THEN
    RAISE EXCEPTION 'SessionPort validation refused: unexpected role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = session_user
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: role not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = session_user
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'SessionPort validation refused: role has superuser/createdb/createrole/bypassrls';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'SessionPort validation refused: PostgreSQL major version is not 16';
  END IF;
  IF pg_catalog.pg_is_in_recovery() THEN
    RAISE EXCEPTION 'SessionPort validation refused: server is in recovery';
  END IF;
  IF pg_catalog.current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'SessionPort validation refused: transaction is read-only';
  END IF;
${renderEmptyCheckBody()}
END
$sessionport_guard$;`;
}

function renderPostDraftAssertions(expectedTables) {
	const tableList = expectedTables.map(sqlStringLiteral).join(", ");
	const tableValues = expectedTables.map((name) => `(${sqlStringLiteral(name)})`).join(", ");
	return `DO $sessionport_assertions$
DECLARE
  v_table_count integer;
  v_primary_key_count integer;
BEGIN
  SELECT count(*) INTO v_table_count
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF v_table_count <> ${expectedTables.length} THEN
    RAISE EXCEPTION 'SessionPort validation failed: public base table count mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN (${tableList})
  ) THEN
    RAISE EXCEPTION 'SessionPort validation failed: unexpected public base table';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind NOT IN ('r', 'i')
  ) THEN
    RAISE EXCEPTION 'SessionPort validation failed: unexpected public relation kind (view/sequence/partitioned/foreign/composite)';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class i
    JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_catalog.pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND i.relkind = 'i'
      AND NOT (
        tn.nspname = 'public'
        AND t.relkind = 'r'
        AND t.relname IN (${tableList})
      )
  ) THEN
    RAISE EXCEPTION 'SessionPort validation failed: index is not on an expected public base table';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES ${tableValues}) AS expected(name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname::text = expected.name
    )
  ) THEN
    RAISE EXCEPTION 'SessionPort validation failed: expected table lacks a primary key';
  END IF;
  SELECT count(*) INTO v_primary_key_count
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary
  WHERE n.nspname = 'public' AND c.relkind = 'r';
  IF v_primary_key_count <> ${expectedTables.length} THEN
    RAISE EXCEPTION 'SessionPort validation failed: primary key count mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = 'user'
      AND a.attname = 'id'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'SessionPort validation failed: vendor user.id is not text';
  END IF;
  IF pg_catalog.to_regclass('public._prisma_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'SessionPort validation failed: _prisma_migrations exists';
  END IF;
END
$sessionport_assertions$;`;
}

function renderSuccessMarker() {
	return `SELECT
  'SESSIONPORT_DRAFT_ASSERTIONS_OK' AS status,
  pg_catalog.current_database() AS database_name,
  current_user AS current_user_name,
  pg_catalog.version() AS server_version,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) AS table_count,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) AS primary_key_count;`;
}

function renderRollbackMarker() {
	return `SELECT
  'SESSIONPORT_ROLLBACK_VERIFIED' AS status,
  pg_catalog.current_database() AS database_name,
  current_user AS current_user_name,
  pg_catalog.version() AS server_version,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) AS table_count,
  (
    SELECT count(*)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) AS primary_key_count;`;
}

/**
 * Builds the rollback-only validation SQL text.
 *
 * The returned string is not executed by this module. The caller must run it
 * only through a reviewed psql invocation with stdin, for example:
 *
 *   psql -X --no-psqlrc --no-password -v ON_ERROR_STOP=1 -f -
 *
 * Do not add psql --single-transaction (or -1); the wrapper manages its own
 * transactions so that the draft and the post-rollback emptiness check are
 * separate. Credentials are supplied by the caller's existing server-side
 * mechanism and must never be embedded in this text. Any psql error aborts via
 * ON_ERROR_STOP; the caller must treat the session as dirty and verify
 * emptiness in a fresh session. There are no retries, cleanup, or DROP steps.
 *
 * @param {{
 *   draftSql: string | Uint8Array,
 *   expectedSha256: string,
 *   expectedTables: string[],
 * }} input
 * @returns {string} SQL text for psql standard input
 */
export function buildValidationSql(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		fail("INPUT_INVALID", "buildValidationSql requires an object argument");
	}
	const { draftSql, expectedSha256, expectedTables } = input;

	const { bytes, text } = toDraftBytesAndText(draftSql);
	const expectedHash = validateExpectedHash(expectedSha256);
	const tables = validateExpectedTables(expectedTables);

	const actualHash = createHash("sha256").update(bytes).digest("hex");
	if (actualHash !== expectedHash) {
		fail(
			"DRAFT_SHA256_MISMATCH",
			`draft SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`,
		);
	}

	scanDraft(text, new Set(tables));

	const draftTerminator = text.endsWith("\n") ? "" : "\n";
	const tableSet = tables.map(sqlStringLiteral).join(", ");

	return `-- SESSIONPORT DRAFT ROLLBACK VALIDATION - NOT A MIGRATION OR DEPLOYMENT.
-- This text is generated, not executed, by cloud/api/schema-tools/build-validation-sql.mjs.
-- Run only through stdin in a single psql session with ON_ERROR_STOP=1.
-- Do not use psql --single-transaction; this text manages its own transactions.
-- The caller supplies psql flags and credentials outside this text.
-- No psql meta-commands or file includes. No retries, cleanup, or DROP.
-- Every DDL change is rolled back. On any error, disconnect and verify the
-- target is empty again in a fresh session; the wrapper cannot guarantee that.
-- Target guard requires database ${VALIDATION_DATABASE} and role ${VALIDATION_ROLE}
-- on PostgreSQL major version 16. All wrapper catalog references are schema-qualified.
-- Reviewed draft SHA-256 (lowercase): ${actualHash}
-- Expected base tables (${tables.length}): ${tableSet}
-- The lexical scanner is a narrow pre-filter, not a SQL parser or a safety proof.
-- Independent draft review plus this hash remains the safety gate.
-- Success requires a zero psql exit status and both fixed SELECT marker rows.

BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
${renderGuard()}
-- Post-guard DDL path: the reviewed Prisma names are unqualified, so creation
-- must target public rather than pg_catalog while the guard's qualified
-- catalogs remain safe. Assertions below are fully qualified.
SET LOCAL search_path = public;
-- BEGIN EXTERNALLY REVIEWED, SHA-256-PINNED DRAFT
${text}${draftTerminator}-- END REVIEWED DRAFT
SET LOCAL search_path = pg_catalog, public;
${renderPostDraftAssertions(tables)}
${renderSuccessMarker()}
ROLLBACK;
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
${renderEmptyAssertions("sessionport_empty")}
ROLLBACK;
${renderRollbackMarker()}
`;
}
