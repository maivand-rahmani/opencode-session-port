import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isNodeTestFile } from "../../cloud/api/scripts/test.mjs";
import {
	checkManifest,
	checkPackedListing,
	classifyPackedPath,
	EXPECTED_DEPENDENCIES,
	EXPECTED_DEV_DEPENDENCIES,
	EXPECTED_EXPORTS,
	EXPECTED_PEER_DEPENDENCIES,
	EXPECTED_VERSION,
	PACKAGE_FILES_ALLOWLIST,
	REPO_ROOT,
	REQUIRED_PACKED_PATHS,
} from "../../scripts/package-verify/verify.ts";

/**
 * Workspace package-boundary invariants. The root package stays the plugin
 * identity (0.1.7, frozen files/exports/scripts/pins); the API member carries
 * the approved L2A dependencies, exact-pinned S3 runtime pins, Prisma
 * client/adapter/tooling, the exact Better Auth runtime pins, and Node test
 * tooling; the web member carries only the exact Next/React pins and their
 * TypeScript tooling. Intentional M3 cloud/native sources are shipped inside
 * the plugin tarball while the cloud/api and cloud/web workspaces stay outside.
 * This is programmatic manifest/config/discovery proof only; no live pack,
 * install, build, network, or runtime listener is exercised here.
 */

const repoRoot = new URL("../..", import.meta.url);
const rootManifest = (await Bun.file(new URL("package.json", repoRoot)).json()) as Record<string, unknown>;
const apiManifest = (await Bun.file(new URL("cloud/api/package.json", repoRoot)).json()) as Record<string, unknown>;
const webManifest = (await Bun.file(new URL("cloud/web/package.json", repoRoot)).json()) as Record<string, unknown>;

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const source = await Bun.file(new URL(relativePath, repoRoot)).text();
	return JSON.parse(source) as Record<string, unknown>;
}

describe("root workspace membership", () => {
	test("declares exactly the two cloud workspaces", () => {
		expect(rootManifest.workspaces).toEqual(["cloud/api", "cloud/web"]);
	});

	test("keeps the frozen plugin identity, allowlist, exports, scripts, and pins", () => {
		expect(rootManifest.name).toBe("opencode-session-port");
		expect(rootManifest.version).toBe(EXPECTED_VERSION);
		expect(rootManifest.private).toBe(false);
		expect(rootManifest.files).toEqual([...PACKAGE_FILES_ALLOWLIST]);
		expect(rootManifest.exports).toEqual(EXPECTED_EXPORTS);
		expect(rootManifest.dependencies).toEqual(EXPECTED_DEPENDENCIES);
		expect(rootManifest.peerDependencies).toEqual(EXPECTED_PEER_DEPENDENCIES);
		expect(rootManifest.devDependencies).toEqual(EXPECTED_DEV_DEPENDENCIES);
		expect(checkManifest(rootManifest)).toEqual([]);
		expect(rootManifest.scripts).toEqual({
			typecheck: "tsc --noEmit",
			test: "bun test",
			"verify:package": "bun run scripts/package-verify/verify.ts",
			"build:tui": "bun run scripts/build-tui.ts",
			prepack: "bun run build:tui",
		});
		expect(rootManifest.packageManager).toBeUndefined();
	});

	test("retains the single Bun lockfile and no npm lockfile", () => {
		expect(existsSync(path.join(REPO_ROOT, "bun.lock"))).toBe(true);
		expect(existsSync(path.join(REPO_ROOT, "package-lock.json"))).toBe(false);
	});
});

describe("API workspace boundary", () => {
	test("declares only the approved L2A runtime and Prisma-pinned dependencies and scripts", () => {
		expect(apiManifest).toEqual({
			name: "@sessionport/api",
			version: "0.0.0",
			private: true,
			type: "module",
			scripts: {
				typecheck: "tsc --noEmit --project tsconfig.json",
				test: "node scripts/test.mjs",
				"db:prepare": "node scripts/prepare-schema.mjs",
				"db:validate": "npm run db:prepare && prisma validate --config prisma.config.ts",
				"db:generate": "npm run db:prepare && prisma generate --config prisma.config.ts",
				"db:deploy": "npm run db:prepare && prisma migrate deploy --config prisma.config.ts",
			},
			dependencies: {
				"@aws-sdk/client-s3": "3.1153.0",
				"@aws-sdk/s3-presigned-post": "3.1153.0",
				"@aws-sdk/s3-request-presigner": "3.1153.0",
				"@better-auth/prisma-adapter": "1.7.11",
				"@prisma/adapter-pg": "7.10.1",
				"@prisma/client": "7.10.1",
				"better-auth": "1.7.11",
				fastify: "5.12.7",
			},
			devDependencies: {
				"@types/node": "24.12.2",
				prisma: "7.10.1",
				tsx: "4.23.15",
				typescript: "5.9.3",
			},
		});
		for (const field of ["exports", "main", "module", "types", "files"]) {
			expect(field in apiManifest).toBe(false);
		}
		// Auth/Prisma/PostgreSQL and S3 runtime surface is exact-pinned, never floating.
		expect(Object.keys(apiManifest.dependencies as Record<string, string>)).toEqual([
			"@aws-sdk/client-s3",
			"@aws-sdk/s3-presigned-post",
			"@aws-sdk/s3-request-presigner",
			"@better-auth/prisma-adapter",
			"@prisma/adapter-pg",
			"@prisma/client",
			"better-auth",
			"fastify",
		]);
		expect((apiManifest.devDependencies as Record<string, string>).prisma).toBe("7.10.1");
		expect((apiManifest.dependencies as Record<string, string>)["better-auth"]).toBe("1.7.11");
		expect((apiManifest.dependencies as Record<string, string>)["@better-auth/prisma-adapter"]).toBe("1.7.11");
	});

	test("uses an independent NodeNext Node config for src and test", async () => {
		const config = await readJson("cloud/api/tsconfig.json");
		const options = config.compilerOptions as Record<string, unknown>;
		expect("extends" in config).toBe(false);
		expect("references" in config).toBe(false);
		expect(config.include).toEqual(["src", "test"]);
		expect(options.target).toBe("ES2022");
		expect(options.module).toBe("NodeNext");
		expect(options.moduleResolution).toBe("NodeNext");
		expect(options.lib).toEqual(["ES2022", "DOM"]);
		expect(options.types).toEqual(["node"]);
		expect(options.strict).toBe(true);
		expect(options.noEmit).toBe(true);
		expect(options.skipLibCheck).toBe(true);
		expect(options.isolatedModules).toBe(true);
		expect(options.jsx).toBeUndefined();
	});

	test("Node test discovery is explicit *.node.ts only", () => {
		expect(isNodeTestFile("health.node.ts")).toBe(true);
		expect(isNodeTestFile("nested/readiness.node.ts")).toBe(true);
		for (const ignored of [
			"health.test.ts",
			"health.spec.ts",
			"health.test.node.ts",
			"health.spec.node.ts",
			"health_test.node.ts",
			"health-spec.node.ts",
			"test-health.node.ts",
			"health.node.mjs",
			"health.node.tsx",
			".node.ts",
		]) {
			expect(isNodeTestFile(ignored)).toBe(false);
		}
		expect(existsSync(path.join(REPO_ROOT, "cloud/api/scripts/test.mjs"))).toBe(true);
	});
});

describe("web workspace boundary", () => {
	test("declares only the exact Next/React runtime and TypeScript tooling pins", () => {
		expect(webManifest.name).toBe("@sessionport/web");
		expect(webManifest.version).toBe("0.0.0");
		expect(webManifest.private).toBe(true);
		expect(webManifest.type).toBe("module");
		expect(webManifest.dependencies).toEqual({
			next: "16.4.2",
			react: "19.3.1",
			"react-dom": "19.3.1",
		});
		const devDependencies = webManifest.devDependencies as Record<string, string>;
		const { tsx, ...requiredDevDependencies } = devDependencies;
		expect(requiredDevDependencies).toEqual({
			"@types/node": "24.12.2",
			"@types/react": "19.3.0",
			"@types/react-dom": "19.3.0",
			typescript: "5.9.3",
		});
		// The web test runner is owned by the UI lane; tsx is the only optional pin.
		if (tsx !== undefined) expect(tsx).toBe("4.23.15");

		const scripts = webManifest.scripts as Record<string, string>;
		expect(scripts).toMatchObject({
			dev: "next dev",
			build: "next build",
			start: "next start",
			typecheck: "tsc --noEmit",
		});
		for (const name of Object.keys(scripts)) {
			expect(["dev", "build", "start", "typecheck", "test"]).toContain(name);
		}
		if (scripts.test !== undefined) expect(scripts.test).toContain("--test");

		for (const field of [
			"peerDependencies",
			"optionalDependencies",
			"bundledDependencies",
			"exports",
			"main",
			"module",
			"types",
			"files",
		]) {
			expect(field in webManifest).toBe(false);
		}
		for (const [name, version] of Object.entries(webManifest.dependencies as Record<string, string>)) {
			expect(version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(name).not.toBe("better-auth");
		}
	});

	test("keeps an independent source-included tsconfig", async () => {
		const config = await readJson("cloud/web/tsconfig.json");
		const options = config.compilerOptions as Record<string, unknown>;
		expect("extends" in config).toBe(false);
		expect("references" in config).toBe(false);
		const include = config.include as string[];
		expect(Array.isArray(include)).toBe(true);
		expect(include.some((entry) => entry === "src" || entry.startsWith("src/"))).toBe(true);
		expect(options.strict).toBe(true);
		expect(options.noEmit).toBe(true);
		// Next 16.4.2 requires this setting and writes it during dev/build.
		expect(options.jsx).toBe("react-jsx");
	});
});

describe("cloud workspace pack exclusion", () => {
	test("cloud paths classify as unexpected and fail a packed listing", () => {
		for (const cloudPath of [
			"cloud/api/package.json",
			"cloud/api/tsconfig.json",
			"cloud/api/scripts/test.mjs",
			"cloud/api/src/server.ts",
			"cloud/web/package.json",
			"cloud/web/tsconfig.json",
			"cloud/web/src/app/page.tsx",
		]) {
			expect(classifyPackedPath(cloudPath)).toBe("unexpected");
		}

		expect(checkPackedListing([...REQUIRED_PACKED_PATHS])).toEqual([]);

		const problems = checkPackedListing([...REQUIRED_PACKED_PATHS, "cloud/api/package.json"]);
		expect(problems).toEqual(["packed listing includes unexpected path outside the allowlist: cloud/api/package.json"]);
	});

	test("root allowlist remains plugin-only", () => {
		expect(PACKAGE_FILES_ALLOWLIST).toEqual(["tui.ts", "src/**", "dist/**", "tsconfig.json"]);
		expect(PACKAGE_FILES_ALLOWLIST.some((entry) => entry.startsWith("cloud"))).toBe(false);
	});
});
