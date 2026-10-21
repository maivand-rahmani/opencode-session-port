import { describe, expect, test } from "bun:test"
import { initialRedirectGuard, recordRedirect, sameOrderedIDs } from "./route-guard"

describe("sync-anchor route redirect guard", () => {
  test("allows ten redirects inside the bounded window and blocks the next", () => {
    let state = initialRedirectGuard
    for (let index = 0; index < 10; index++) {
      const decision = recordRedirect(state, index * 40)
      expect(decision.allowed).toBe(true)
      state = decision.state
    }

    const blocked = recordRedirect(state, 400)
    expect(blocked.allowed).toBe(false)
    expect(blocked.state.blocked).toBe(true)
    expect(recordRedirect(blocked.state, 900).allowed).toBe(false)
  })

  test("drops redirects outside the 500ms window", () => {
    let state = initialRedirectGuard
    for (let index = 0; index < 10; index++) {
      state = recordRedirect(state, index * 40).state
    }

    const afterWindow = recordRedirect(state, 501)
    expect(afterWindow.allowed).toBe(true)
    expect(afterWindow.state.blocked).toBe(false)
  })
})

describe("ordered cache message identity", () => {
  const rootMessages = [{ id: "msg-root-user", body: "user" }, { id: "msg-root-assistant", body: "assistant" }]
  const childMessages = [{ id: "msg-child-user", body: "user" }, { id: "msg-child-assistant", body: "assistant" }]
  const rootIDs = rootMessages.map((message) => message.id)
  const childIDs = childMessages.map((message) => message.id)

  test("accepts the exact ordered imported IDs", () => expect(sameOrderedIDs(rootIDs, rootIDs)).toBe(true))
  test("rejects another session's IDs even when message bodies match", () => {
    expect(childMessages.map((message) => message.body)).toEqual(rootMessages.map((message) => message.body))
    expect(sameOrderedIDs(childIDs, rootIDs)).toBe(false)
  })
  test("rejects reversed IDs", () => expect(sameOrderedIDs([...rootIDs].reverse(), rootIDs)).toBe(false))
  test("rejects missing IDs", () => expect(sameOrderedIDs(rootIDs.slice(0, 1), rootIDs)).toBe(false))
  test("rejects duplicate IDs", () => expect(sameOrderedIDs([rootIDs[0], rootIDs[0]], rootIDs)).toBe(false))
})
