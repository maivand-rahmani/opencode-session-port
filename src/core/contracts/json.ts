/** JSON-compatible values accepted at the SessionPort payload boundary. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

type VisitFrame = {
	kind: "visit";
	value: unknown;
	path: string;
	assign: (copy: JsonValue) => void;
};

type LeaveFrame = { kind: "leave"; value: object };

/**
 * Copies a JSON-only snapshot, rejecting data that JSON would omit or coerce.
 * Copies use null prototypes so inherited `toJSON` hooks cannot change the
 * serialized representation. The traversal is iterative to avoid JS call-stack
 * recursion. Resource limits are enforced by higher layers.
 *
 * `-0` is rejected because JSON.stringify would serialize it as `0`.
 */
export function snapshotJsonValue(value: unknown, rootPath = "$"): JsonValue {
	let root: JsonValue | undefined;
	const active = new WeakSet<object>();
	const stack: Array<VisitFrame | LeaveFrame> = [
		{ kind: "visit", value, path: rootPath, assign: (copy) => (root = copy) },
	];

	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (frame.kind === "leave") {
			active.delete(frame.value);
			continue;
		}

		const current = frame.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") {
			frame.assign(current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError(`Non-finite number at ${frame.path}`);
			if (Object.is(current, -0)) throw new TypeError(`Negative zero is not JSON-stable at ${frame.path}`);
			frame.assign(current);
			continue;
		}
		if (typeof current !== "object") {
			throw new TypeError(`Non-JSON value (${typeof current}) at ${frame.path}`);
		}
		if (active.has(current)) throw new TypeError(`Cyclic value at ${frame.path}`);

		if (Array.isArray(current)) {
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Array.prototype && prototype !== null) {
				throw new TypeError(`Non-plain array at ${frame.path}`);
			}
			const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
			const length = lengthDescriptor?.value;
			if (!Number.isSafeInteger(length) || length < 0) {
				throw new TypeError(`Invalid array length at ${frame.path}`);
			}

			const values = new Map<number, unknown>();
			for (const key of Reflect.ownKeys(current)) {
				if (key === "length") continue;
				if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
					throw new TypeError(`Non-JSON array property at ${frame.path}`);
				}
				const index = Number(key);
				if (!Number.isSafeInteger(index) || index >= length) {
					throw new TypeError(`Unsupported array entry at ${frame.path}[${key}]`);
				}
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					throw new TypeError(`Accessor or hidden array entry at ${frame.path}[${key}]`);
				}
				values.set(index, descriptor.value);
			}
			if (values.size !== length) throw new TypeError(`Sparse array at ${frame.path}`);

			const copy = new Array<JsonValue>(length);
			Object.setPrototypeOf(copy, null);
			frame.assign(copy);
			active.add(current);
			stack.push({ kind: "leave", value: current });
			for (let index = length - 1; index >= 0; index--) {
				stack.push({
					kind: "visit",
					value: values.get(index),
					path: `${frame.path}[${index}]`,
					assign: (child) => (copy[index] = child),
				});
			}
			continue;
		}

		const prototype = Object.getPrototypeOf(current);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`Non-plain object at ${frame.path}`);
		}
		const entries: Array<{ key: string; value: unknown }> = [];
		for (const key of Reflect.ownKeys(current)) {
			if (typeof key !== "string") throw new TypeError(`Symbol property at ${frame.path}`);
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw new TypeError(`Non-enumerable or accessor property at ${frame.path}[${JSON.stringify(key)}]`);
			}
			entries.push({ key, value: descriptor.value });
		}

		const copy = Object.create(null) as { [key: string]: JsonValue };
		frame.assign(copy);
		active.add(current);
		stack.push({ kind: "leave", value: current });
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			stack.push({
				kind: "visit",
				value: entry.value,
				path: `${frame.path}[${JSON.stringify(entry.key)}]`,
				assign: (child) => (copy[entry.key] = child),
			});
		}
	}

	if (root === undefined) throw new TypeError("JSON snapshot was not produced");
	return root;
}

/** Serializes a detached JSON snapshot; inherited hooks and source mutation cannot rewrite it. */
export function encodeJson(value: unknown): Uint8Array {
	const snapshot = snapshotJsonValue(value);
	const encoded = JSON.stringify(snapshot);
	if (encoded === undefined) throw new TypeError("Value could not be serialized as JSON");
	return new TextEncoder().encode(encoded);
}
