/**
 * Windows process-memory reader for the diagnostic harness (supervisor side).
 *
 * Uses the Windows API `GetProcessMemoryInfo` (PROCESS_MEMORY_COUNTERS) via Bun FFI:
 *   - WorkingSetSize     -> current working set (physical residency), bytes
 *   - PeakWorkingSetSize -> process-lifetime peak working set, bytes
 *
 * Deliberately NOT used: `Bun.spawn().resourceUsage().maxRSS` (documented Windows
 * unit discrepancies) and `process.resourceUsage()` (applies to self only; the
 * child is blocked during the synchronous KDF so it cannot sample itself).
 *
 * Byte units were verified on the recorded host (Bun 1.3.10 / Windows 11 x64) by
 * `selfcheck-winmem.ts`: WorkingSetSize matched `process.memoryUsage().rss` within
 * 0.1% (both bytes). x64 assumption: SIZE_T is 8 bytes, so the struct is 72 bytes
 * with PeakWorkingSetSize at offset 8 and WorkingSetSize at offset 16.
 *
 * A terminated process's PeakWorkingSetSize remains readable while this module
 * holds its own OpenProcess handle (verified on the recorded host); the supervisor
 * still keeps an alive-read fallback.
 */

import { dlopen, FFIType } from "bun:ffi";

export interface ProcessMemoryCounters {
	workingSetBytes: number;
	peakWorkingSetBytes: number;
}

export interface ProcessMemoryReader {
	readonly pid: number;
	read(): ProcessMemoryCounters;
	close(): void;
}

// PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
const OPEN_PROCESS_ACCESS = 0x0400 | 0x1000 | 0x0010;

// sizeof(PROCESS_MEMORY_COUNTERS) on 64-bit Windows.
const COUNTERS_SIZE = 72;
const PEAK_WORKING_SET_OFFSET = 8;
const WORKING_SET_OFFSET = 16;

type GetProcessMemoryInfoFn = (handle: number, counters: Uint8Array, size: number) => number;
type OpenProcessFn = (access: number, inherit: number, pid: number) => unknown;
type CloseHandleFn = (handle: number) => number;

interface Win32MemoryLibs {
	getProcessMemoryInfo: GetProcessMemoryInfoFn;
	openProcess: OpenProcessFn;
	closeHandle: CloseHandleFn;
}

let cachedLibs: Win32MemoryLibs | null = null;

function loadWin32MemoryLibs(): Win32MemoryLibs {
	if (cachedLibs !== null) {
		return cachedLibs;
	}
	if (process.platform !== "win32") {
		throw new Error("the process-memory reader is Windows-only");
	}
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error(`unsupported Windows architecture for PROCESS_MEMORY_COUNTERS: ${process.arch}`);
	}

	let getProcessMemoryInfo: GetProcessMemoryInfoFn;
	try {
		getProcessMemoryInfo = dlopen("psapi.dll", {
			GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		}).symbols.GetProcessMemoryInfo as GetProcessMemoryInfoFn;
	} catch {
		getProcessMemoryInfo = dlopen("kernel32.dll", {
			K32GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		}).symbols.K32GetProcessMemoryInfo as GetProcessMemoryInfoFn;
	}

	const kernel32 = dlopen("kernel32.dll", {
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
	});

	cachedLibs = {
		getProcessMemoryInfo,
		openProcess: kernel32.symbols.OpenProcess as OpenProcessFn,
		closeHandle: kernel32.symbols.CloseHandle as CloseHandleFn,
	};
	return cachedLibs;
}

function normalizeHandle(raw: unknown): number | null {
	const value = typeof raw === "bigint" ? Number(raw) : (raw as number | null | undefined);
	if (value === null || value === undefined || value === 0 || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

export function openProcessMemoryReader(pid: number): ProcessMemoryReader {
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`openProcessMemoryReader requires a positive pid, got ${pid}`);
	}
	const libs = loadWin32MemoryLibs();
	const handle = normalizeHandle(libs.openProcess(OPEN_PROCESS_ACCESS, 0, pid));
	if (handle === null) {
		throw new Error(
			`OpenProcess failed for pid ${pid} (access 0x${OPEN_PROCESS_ACCESS.toString(16)}); the process may have exited`,
		);
	}

	const buffer = new Uint8Array(COUNTERS_SIZE);
	const view = new DataView(buffer.buffer);
	let closed = false;

	return {
		pid,
		read(): ProcessMemoryCounters {
			if (closed) {
				throw new Error("process-memory reader is closed");
			}
			// cb is an input field: size of the struct being passed.
			view.setUint32(0, COUNTERS_SIZE, true);
			const ok = libs.getProcessMemoryInfo(handle, buffer, COUNTERS_SIZE);
			if (ok === 0) {
				throw new Error(`GetProcessMemoryInfo failed for pid ${pid}`);
			}
			return {
				workingSetBytes: Number(view.getBigUint64(WORKING_SET_OFFSET, true)),
				peakWorkingSetBytes: Number(view.getBigUint64(PEAK_WORKING_SET_OFFSET, true)),
			};
		},
		close(): void {
			if (closed) {
				return;
			}
			closed = true;
			libs.closeHandle(handle);
		},
	};
}
