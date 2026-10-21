export type RedirectGuard = {
  readonly recent: readonly number[]
  readonly blocked: boolean
}

export function recordRedirect(state: RedirectGuard, now: number): { readonly state: RedirectGuard; readonly allowed: boolean } {
  if (state.blocked) return { state, allowed: false }

  const recent = state.recent.filter((at) => now >= at && now - at < 500)
  if (recent.length >= 10) return { state: { recent, blocked: true }, allowed: false }

  return { state: { recent: [...recent, now], blocked: false }, allowed: true }
}

export const initialRedirectGuard: RedirectGuard = { recent: [], blocked: false }

export function sameOrderedIDs(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index])
}
