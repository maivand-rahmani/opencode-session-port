import { describe, expect, test } from "bun:test";
import {
	bunInstallArgs,
	checkManifest,
	checkPackagedTsconfig,
	EXPECTED_DEPENDENCIES,
	EXPECTED_DESCRIPTION,
	EXPECTED_DEV_DEPENDENCIES,
	EXPECTED_EXPORTS,
	EXPECTED_KEYWORDS,
	EXPECTED_LICENSE,
	EXPECTED_PACKAGE_NAME,
	EXPECTED_PEER_DEPENDENCIES,
	EXPECTED_REPOSITORY,
	EXPECTED_VERSION,
	FORBIDDEN_MANIFEST_FIELDS,
	npmHostPeerInstallArgs,
	npmInstallArgs,
	PACKAGE_FILES_ALLOWLIST,
} from "../../scripts/package-verify/verify.ts";

/**
 * Frozen packaging-manifest invariants. These tests pin the publishing
 * identity (`opencode-session-port`, MIT license, reviewed description and
 * keywords), the compiled-entry exports (`./tui` -> `dist/tui.js`), required
 * UI peers aligned to the tested set (no `optional:true`), the `build:tui` /
 * `prepack` build hook, exact dependency pins, allowlist, and no-publish
 * posture so later phases cannot silently widen the packed surface or add
 * deferred registry/runtime metadata. The package is `private:false` as
 * publishing preparation only; no publish command is run anywhere in this
 * workspace.
 */

const repoRoot = new URL("../..", import.meta.url);
const manifest = (await Bun.file(new URL("package.json", repoRoot)).json()) as Record<string, unknown>;
const tsconfigSource = await Bun.file(new URL("tsconfig.json", repoRoot)).text();

describe("package manifest invariants", () => {
	test("identity, allowlist, and compiled exports stay frozen", () => {
		expect(manifest.name).toBe(EXPECTED_PACKAGE_NAME);
		expect(manifest.version).toBe(EXPECTED_VERSION);
		expect(manifest.private).toBe(false);
		expect(manifest.license).toBe(EXPECTED_LICENSE);
		expect(manifest.files).toEqual([...PACKAGE_FILES_ALLOWLIST]);
		expect(manifest.exports).toEqual(EXPECTED_EXPORTS);
		expect(manifest.exports).toEqual({ "./tui": "./dist/tui.js" });
	});

	test("publishing description and keywords stay the reviewed wording", () => {
		expect(manifest.description).toBe(EXPECTED_DESCRIPTION);
		expect(manifest.keywords).toEqual([...EXPECTED_KEYWORDS]);
	});

	test("dependency, peer, and dev pins stay exact", () => {
		expect(manifest.dependencies).toEqual(EXPECTED_DEPENDENCIES);
		expect(manifest.peerDependencies).toEqual(EXPECTED_PEER_DEPENDENCIES);
		expect(manifest.devDependencies).toEqual(EXPECTED_DEV_DEPENDENCIES);
		// All three UI peers are required: no optional metadata may reappear.
		expect(manifest.peerDependenciesMeta).toBeUndefined();
		// solid-js is aligned to the exact peer declared by @opentui/solid 0.5.14.
		expect((manifest.peerDependencies as Record<string, string>)["solid-js"]).toBe("1.9.12");
		expect((manifest.devDependencies as Record<string, string>)["solid-js"]).toBe("1.9.12");
	});

	test("checkManifest reports no violations", () => {
		expect(checkManifest(manifest)).toEqual([]);
	});

	test("deferred registry/runtime metadata stays absent", () => {
		for (const field of FORBIDDEN_MANIFEST_FIELDS) {
			expect(field in manifest).toBe(false);
		}
		expect(manifest.publishConfig).toBeUndefined();
		expect(manifest.homepage).toBeUndefined();
		expect(manifest.author).toBeUndefined();
	});

	test("repository metadata is exactly the reviewed GitHub identity", () => {
		// CI-02: the expected repository object is approved metadata (OIDC
		// trusted publishing needs repository.url to match the GitHub origin),
		// but nothing else about the repository field may drift.
		expect(manifest.repository).toEqual(EXPECTED_REPOSITORY);
		expect(EXPECTED_REPOSITORY).toEqual({
			type: "git",
			url: "git+https://github.com/maivand-rahmani/opencode-session-port.git",
		});
		expect(checkManifest(manifest)).toEqual([]);
	});

	test("malformed or unexpected repository metadata is rejected", () => {
		const cases: unknown[] = [
			undefined,
			"maivand-rahmani/opencode-session-port",
			{ type: "git", url: "git+https://github.com/attacker/opencode-session-port.git" },
			{ type: "svn", url: EXPECTED_REPOSITORY.url },
			{ type: "git", url: EXPECTED_REPOSITORY.url, extra: true },
		];
		for (const repository of cases) {
			expect(checkManifest({ ...manifest, repository })).not.toEqual([]);
		}
	});

	test("build hook scripts exist and no publish/post-install hooks are added", () => {
		const scripts = manifest.scripts as Record<string, string>;
		expect(scripts.test).toBe("bun test");
		expect(scripts.typecheck).toBe("tsc --noEmit");
		expect(scripts["verify:package"]).toBe("bun run scripts/package-verify/verify.ts");
		expect(scripts["build:tui"]).toBe("bun run scripts/build-tui.ts");
		expect(scripts.prepack).toBe("bun run build:tui");
		for (const name of Object.keys(scripts)) {
			if (name === "prepack") continue; // required compiled-entry build hook
			expect(/publish|postpack|prepare|postinstall|preinstall/.test(name)).toBe(false);
		}
	});

	test("packaged tsconfig preserves @opentui/solid JSX source semantics", () => {
		expect(checkPackagedTsconfig(tsconfigSource)).toEqual([]);
		const parsed = JSON.parse(tsconfigSource) as { compilerOptions: Record<string, unknown> };
		expect(parsed.compilerOptions.jsx).toBe("preserve");
		expect(parsed.compilerOptions.jsxImportSource).toBe("@opentui/solid");
	});

	test("install commands disable scripts and audit/fund chatter", () => {
		expect(npmInstallArgs("pkg.tgz")).toEqual(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "pkg.tgz"]);
		expect(bunInstallArgs()).toEqual(["install", "--ignore-scripts"]);
		expect(npmHostPeerInstallArgs()).toContain("--ignore-scripts");
		expect(npmHostPeerInstallArgs()).toContain("--legacy-peer-deps");
		expect(npmHostPeerInstallArgs()).toContain("solid-js@1.9.12");
	});

	test("verification script stays repository-local and never publishes", async () => {
		const source = await Bun.file(new URL("scripts/package-verify/verify.ts", repoRoot)).text();
		expect(source).not.toContain("AppData");
		expect(source).not.toContain("tmpdir");
		for (const forbidden of ["npm publish", "bun publish", "pnpm publish", "yarn publish", "prepublish", "postpublish"]) {
			expect(source).not.toContain(forbidden);
		}
		expect(source).toContain(".package-verify-work");
	});
});
