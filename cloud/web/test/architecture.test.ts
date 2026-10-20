import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(webRoot, "src");

const LAYER_ORDER = new Map<string, number>([
	["_app", 0],
	["_pages", 1],
	["widgets", 2],
	["features", 3],
	["entities", 4],
	["shared", 5],
]);

const APP_ADAPTERS = new Set([
	"app/layout.tsx",
	"app/page.tsx",
	"app/login/page.tsx",
	"app/device/page.tsx",
	"app/devices/page.tsx",
	"app/api/auth/[...auth]/route.ts",
	"app/api/native/v1/[...unknown]/route.ts",
	"app/api/native/v1/device-authorizations/approve/route.ts",
	"app/api/native/v1/device-authorizations/deny/route.ts",
	"app/api/native/v1/device-authorizations/verify/route.ts",
	"app/api/native/v1/grants/route.ts",
	"app/api/native/v1/grants/[grantID]/revoke/route.ts",
	"app/api/native/v1/session/route.ts",
]);

type SourceFileInfo = {
	file: string;
	relative: string;
	text: string;
	source: ts.SourceFile;
	client: boolean;
};

type LocalImport = {
	specifier: string;
	line: number;
	resolved: string | null;
};

function walk(directory: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
		} else if (/\.(ts|tsx)$/.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

function readSources(): SourceFileInfo[] {
	return walk(srcRoot)
		.sort()
		.map((file) => {
			const text = fs.readFileSync(file, "utf8");
			const source = ts.createSourceFile(
				file,
				text,
				ts.ScriptTarget.Latest,
				true,
				file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			);
			return {
				file,
				relative: path.relative(srcRoot, file).split(path.sep).join("/"),
				text,
				source,
				client: isClientModule(source),
			};
		});
}

function isClientModule(source: ts.SourceFile): boolean {
	const first = source.statements[0];
	return Boolean(
		first &&
		ts.isExpressionStatement(first) &&
		ts.isStringLiteral(first.expression) &&
		first.expression.text === "use client",
	);
}

function collectLocalImports(info: SourceFileInfo): LocalImport[] {
	const imports: LocalImport[] = [];
	const record = (specifier: string, node: ts.Node) => {
		if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return;
		imports.push({
			specifier,
			line: info.source.getLineAndCharacterOfPosition(node.getStart(info.source)).line + 1,
			resolved: resolveLocal(info.file, specifier),
		});
	};

	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			record(node.moduleSpecifier.text, node);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			record(node.moduleSpecifier.text, node);
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const expression = node.moduleReference.expression;
			if (expression && ts.isStringLiteral(expression)) record(expression.text, node);
		} else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
			const specifier = node.arguments[0].text;
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				record(specifier, node);
			} else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
				record(specifier, node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(info.source);
	return imports;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
	const base = specifier.startsWith("@/")
		? path.join(srcRoot, specifier.slice(2))
		: path.resolve(path.dirname(fromFile), specifier);

	if (specifier.endsWith(".css")) {
		return fs.existsSync(base) && fs.statSync(base).isFile() ? base : null;
	}

	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
		path.join(base, "index.server.ts"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

type Classification =
	| { kind: "adapter"; relative: string }
	| { kind: "layer"; layer: string; slice: string; relative: string }
	| { kind: "unknown"; relative: string };

function classify(file: string): Classification {
	const relative = path.relative(srcRoot, file).split(path.sep).join("/");
	if (relative === "proxy.ts" || relative.startsWith("app/")) {
		return { kind: "adapter", relative };
	}
	const segments = relative.split("/");
	const layer = segments[0];
	if (LAYER_ORDER.has(layer)) {
		return { kind: "layer", layer, slice: segments[1] ?? "", relative };
	}
	return { kind: "unknown", relative };
}

function isPublicEntry(file: string): boolean {
	const base = path.basename(file);
	return base === "index.ts" || base === "index.tsx" || base === "index.server.ts";
}

function formatImport(info: SourceFileInfo, item: LocalImport): string {
	return `${info.relative}:${item.line} -> ${item.specifier}`;
}

test("FSD source tree uses known layers and has no legacy catch-all directories", () => {
	const sources = readSources();
	assert.ok(sources.length >= 40, `expected the full source graph, found ${sources.length} files`);
	assert.equal(fs.existsSync(path.join(srcRoot, "components")), false, "src/components must not exist");
	assert.equal(fs.existsSync(path.join(srcRoot, "lib")), false, "src/lib must not exist");
	assert.equal(fs.existsSync(path.join(srcRoot, "app", "globals.css")), false, "global styles live under _app/styles");

	const expectedEntries = [
		"_app/server/index.server.ts",
		"_app/security/index.server.ts",
		"_app/styles/globals.css",
		"_pages/login/index.ts",
		"_pages/device-approval/index.ts",
		"_pages/connected-devices/index.ts",
		"widgets/site-frame/index.ts",
		"features/github-sign-in/index.ts",
		"features/sign-out/index.ts",
		"features/device-authorization/index.ts",
		"features/revoke-device/index.ts",
		"entities/browser-session/index.ts",
		"entities/device-grant/index.ts",
		"shared/api/index.ts",
		"shared/ui/feedback/index.ts",
	];
	for (const entry of expectedEntries) {
		assert.equal(fs.existsSync(path.join(srcRoot, entry)), true, `missing expected FSD entry ${entry}`);
	}

	for (const source of sources) {
		const classification = classify(source.file);
		assert.notEqual(classification.kind, "unknown", `${source.relative} is outside the known FSD layers`);
	}
});

test("local imports follow layer direction, slice boundaries, and public APIs", () => {
	const sources = readSources();
	const violations: string[] = [];

	for (const source of sources) {
		const sourceClass = classify(source.file);
		for (const item of collectLocalImports(source)) {
			if (item.resolved === null) {
				violations.push(`${formatImport(source, item)} (unresolved local import)`);
				continue;
			}
			const targetClass = classify(item.resolved);

			if (targetClass.kind === "unknown") {
				violations.push(`${formatImport(source, item)} (target outside known layers)`);
				continue;
			}
			const targetLayer = targetClass.kind === "layer" ? targetClass.layer : null;
			const targetSlice = targetClass.kind === "layer" ? targetClass.slice : null;
			const targetRelative = targetClass.relative;

			if (sourceClass.kind === "adapter") {
				if (targetLayer === null) {
					violations.push(`${formatImport(source, item)} (adapter importing another adapter)`);
					continue;
				}
				const allowed = targetLayer === "_app" || targetLayer === "_pages" || targetLayer === "features";
				if (!allowed) {
					violations.push(`${formatImport(source, item)} (adapter may import _app, _pages, or public feature server entries)`);
				} else if (targetLayer === "features" && !targetRelative.endsWith("index.server.ts")) {
					violations.push(`${formatImport(source, item)} (adapter feature import must use index.server.ts)`);
				} else if (!targetRelative.endsWith(".css") && !isPublicEntry(item.resolved)) {
					violations.push(`${formatImport(source, item)} (adapter must use a public slice index)`);
				}
				continue;
			}

			if (targetLayer === null || targetSlice === null) {
				violations.push(`${formatImport(source, item)} (FSD code importing a Next adapter)`);
				continue;
			}
			if (sourceClass.kind !== "layer") continue;
			const sourceLayer = sourceClass.layer;

			const sourceOrder = LAYER_ORDER.get(sourceLayer)!;
			const targetOrder = LAYER_ORDER.get(targetLayer)!;
			if (targetOrder < sourceOrder) {
				violations.push(`${formatImport(source, item)} (${sourceLayer} may not import ${targetLayer})`);
			}

			const sameSlice = sourceLayer === targetLayer && sourceClass.slice === targetSlice;
			if (sourceLayer === targetLayer && !sameSlice && sourceLayer !== "shared") {
				violations.push(`${formatImport(source, item)} (same-layer cross-slice import)`);
			}

			const sharedToShared = sourceLayer === "shared" && targetLayer === "shared";
			if (!sameSlice && !sharedToShared && !targetRelative.endsWith(".css") && !isPublicEntry(item.resolved)) {
				violations.push(`${formatImport(source, item)} (cross-slice import must use a public index)`);
			}
		}
	}

	assert.deepEqual(violations, []);
});

test("Next app files and proxy remain thin, whitelisted adapters", () => {
	const sources = readSources();
	const violations: string[] = [];

	for (const source of sources) {
		if (!source.relative.startsWith("app/")) continue;
		if (!APP_ADAPTERS.has(source.relative)) {
			violations.push(`${source.relative} is not a whitelisted app adapter`);
		}
	}

	assert.deepEqual(violations, []);

	const layout = fs.readFileSync(path.join(srcRoot, "app", "layout.tsx"), "utf8");
	assert.match(layout, /\.\.\/_app\/styles\/globals\.css/);
	assert.equal(fs.existsSync(path.join(srcRoot, "app", "login", "page.tsx")), true);
	assert.equal(fs.existsSync(path.join(srcRoot, "_pages", "login", "index.ts")), true);
});

test("server BFF is isolated from client code and uses an explicit server entrypoint", () => {
	const sources = readSources();
	const serverRoot = path.join(srcRoot, "_app", "server");
	const serverPublic = path.join(serverRoot, "index.server.ts");
	const violations: string[] = [];
	const edges = new Map<string, string[]>();

	assert.equal(fs.existsSync(serverPublic), true);
	assert.equal(fs.existsSync(path.join(serverRoot, "index.ts")), false, "server BFF must not have a client index.ts barrel");

	for (const source of sources) {
		const localImports = collectLocalImports(source);
		edges.set(source.file, localImports.flatMap((item) => item.resolved === null ? [] : [item.resolved]));

		for (const item of localImports) {
			if (item.resolved === null) continue;
			const importsServer = item.resolved === serverPublic || item.resolved.startsWith(serverRoot + path.sep);
			if (!importsServer) continue;

			const isServerImplementation = source.file.startsWith(serverRoot + path.sep);
			const isApiAdapter = /^app\/api\/.+\/route\.ts$/.test(source.relative);
			if (!isServerImplementation && !isApiAdapter) {
				violations.push(`${formatImport(source, item)} (only API route adapters and the server slice may import the BFF)`);
			}
			if (source.client) {
				violations.push(`${formatImport(source, item)} (client module imports the server BFF)`);
			}
		}
	}

	for (const source of sources.filter((item) => item.client)) {
		const seen = new Set<string>();
		const queue = [source.file];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.startsWith(serverRoot + path.sep)) {
				violations.push(`${source.relative} reaches the server BFF through the client import graph`);
				break;
			}
			if (seen.has(current)) continue;
			seen.add(current);
			queue.push(...(edges.get(current) ?? []));
		}
	}

	assert.deepEqual([...new Set(violations)], []);
});

test("client modules do not expose server configuration or CSRF key material", () => {
	const sources = readSources();
	const forbidden = [
		"SESSIONPORT_INTERNAL_API_ORIGIN",
		"SESSIONPORT_WEB_POLICY_JSON",
		"SESSIONPORT_CSRF_SECRET",
		"SESSIONPORT_NATIVE_CSRF_KEY_BASE64",
		"readServerConfig",
		"readServerPolicy",
	];
	const violations: string[] = [];
	for (const source of sources.filter((item) => item.client)) {
		for (const token of forbidden) {
			if (source.text.includes(token)) {
				violations.push(`${source.relative} contains ${token}`);
			}
		}
	}
	assert.deepEqual(violations, []);
});
