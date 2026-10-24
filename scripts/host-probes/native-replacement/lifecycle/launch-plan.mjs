// Guarded Docker command plan. This module only builds and validates argv; it never runs Docker.

import { posix } from "node:path"

const DIGEST = /^sha256:[0-9a-f]{64}$/
const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/
const MEMORY = /^(256|512)m$|^1g$/
const ENTRY_ROOT = "/opt/sessionport/lifecycle/"

export class PlanError extends Error {
  constructor(code) {
    super(code)
    this.name = "PlanError"
    this.code = code
  }
}

const fail = (code) => { throw new PlanError(code) }

export function buildDockerRunPlan(input) {
  if (!input || typeof input !== "object") fail("E_CONFIG")
  const imageDigest = input.imageDigest
  if (typeof imageDigest !== "string" || !DIGEST.test(imageDigest)) fail("E_IMAGE_IMMUTABLE_REQUIRED")
  const containerName = input.containerName
  if (typeof containerName !== "string" || !NAME.test(containerName)) fail("E_CONTAINER_NAME")
  const profileBase = input.profileBase ?? "/run/sessionport"
  if (typeof profileBase !== "string" || !posix.isAbsolute(profileBase) || profileBase === "/") fail("E_PROFILE")
  if (posix.normalize(profileBase) !== profileBase || profileBase.includes("..")) fail("E_PROFILE")
  const entry = input.entry ?? `${ENTRY_ROOT}entry.mjs`
  if (typeof entry !== "string" || !posix.isAbsolute(entry) || !entry.startsWith(ENTRY_ROOT)) fail("E_ENTRY")
  const pids = input.pidsLimit ?? 256
  const memory = input.memory ?? "1g"
  if (!Number.isInteger(pids) || pids < 32 || pids > 1024) fail("E_LIMITS")
  if (!MEMORY.test(memory)) fail("E_LIMITS")

  const tmpfs = (target, size) =>
    `${target}:rw,noexec,nosuid,nodev,size=${size},mode=700,uid=1000,gid=1000`
  const argv = [
    "docker", "run",
    "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(pids),
    "--memory", memory,
    "--user", "1000:1000",
    "--workdir", profileBase,
    "--tmpfs", tmpfs(profileBase, "64m"),
    "--tmpfs", tmpfs("/tmp", "16m"),
    imageDigest,
    "node", entry,
  ]
  return { image: imageDigest, containerName, profileBase, entry, argv }
}

export function verifyDockerRunPlan(plan) {
  if (!plan || !Array.isArray(plan.argv)) fail("E_CONFIG")
  const argv = plan.argv
  const violations = []
  const has = (flag) => argv.includes(flag)
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  if (argv[0] !== "docker" || argv[1] !== "run") violations.push("docker-run-required")
  if (!plan.image || !DIGEST.test(plan.image)) violations.push("immutable-image-required")
  if (has("--rm")) violations.push("rm-forbidden-retain-on-uncertainty")
  if (has("--privileged")) violations.push("privileged-forbidden")
  if (has("-p") || has("--publish") || has("-P")) violations.push("host-port-forbidden")
  if (has("-v") || has("--volume") || has("--mount")) violations.push("host-mount-forbidden")
  if (has("--env") || has("-e") || has("--env-file")) violations.push("env-secret-forbidden")
  if (value("--network") !== "none") violations.push("network-none-required")
  if (!has("--read-only")) violations.push("read-only-required")
  if (value("--cap-drop") !== "ALL") violations.push("cap-drop-all-required")
  if (value("--security-opt") !== "no-new-privileges") violations.push("no-new-privileges-required")
  if (!value("--pids-limit") || !value("--memory")) violations.push("resource-limits-required")
  if (!argv.some((arg) => arg.startsWith(`${plan.profileBase}:`))) violations.push("fresh-profile-tmpfs-required")
  if (!argv.some((arg) => arg.startsWith("/tmp:"))) violations.push("tmp-tmpfs-required")
  return violations
}
