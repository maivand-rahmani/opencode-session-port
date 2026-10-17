/**
 * Pure statistics for the Windows-only KDF diagnostic harness.
 * No I/O, no crypto, no process APIs; safe to unit test.
 *
 * Percentiles use the nearest-rank (order-statistic) method:
 *   rank = ceil(percentile / 100 * n), 1-based; value = sorted[rank - 1].
 * This is deterministic and documented so report numbers are reproducible.
 */

export interface NumericStats {
	count: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
	mean: number;
}

export function computeStats(values: readonly number[]): NumericStats {
	if (!Array.isArray(values) || values.length === 0) {
		throw new Error("computeStats requires at least one value");
	}
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error("computeStats requires finite, non-negative numbers");
		}
	}
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		min: sorted[0]!,
		p50: nearestRank(sorted, 50),
		p95: nearestRank(sorted, 95),
		max: sorted[sorted.length - 1]!,
		mean: sum / sorted.length,
	};
}

function nearestRank(sorted: readonly number[], percentile: number): number {
	const rank = Math.ceil((percentile / 100) * sorted.length);
	const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
	return sorted[index]!;
}
