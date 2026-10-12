// unit tests for the pure quota helpers. run with: npm test
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildLabels,
  clamp,
  compactAge,
  countdown,
  localPart,
  nextBackoff,
  percent,
  remainingFromUsed,
  shortTag,
  truncate,
  windowLabel,
  asTime,
  type Account,
} from "../quota.ts"

function account(partial: Partial<Account> & { key: string; label: string }): Account {
  return {
    credentialID: partial.key,
    integrationID: "openai",
    integrationName: "ChatGPT",
    identity: "",
    status: "ok",
    windows: [],
    credits: [],
    active: false,
    tier: "connected",
    ...partial,
  } as Account
}

test("remaining percentage is derived from used and limit", () => {
  assert.equal(remainingFromUsed(0, 1_200_000_000), 100)
  assert.equal(remainingFromUsed(600_000_000, 1_200_000_000), 50)
  assert.equal(remainingFromUsed(1_200_000_000, 1_200_000_000), 0)
  // never above 100 or below 0, even if a provider reports an odd pair
  assert.equal(remainingFromUsed(-5, 100), 100)
  assert.equal(remainingFromUsed(150, 100), 0)
  assert.equal(remainingFromUsed(1, 0), null)
})

test("percentages are formatted as remaining, never rounded up to a lie", () => {
  assert.equal(percent(100), "100%")
  assert.equal(percent(99.6), "100%")
  assert.equal(percent(99.4), "99%")
  assert.equal(percent(53.2), "53%")
  assert.equal(percent(4.25), "4.3%")
  assert.equal(percent(null), "--")
})

test("countdowns stay compact", () => {
  const now = 1_800_000_000_000
  assert.equal(countdown(now + 45_000, now), "45s")
  assert.equal(countdown(now + 90 * 60_000, now), "1h30m")
  assert.equal(countdown(now + 26 * 3_600_000, now), "1d2h")
  assert.equal(countdown(now - 1000, now), "now")
  assert.equal(countdown(null, now), "--")
})

test("window labels come from the provider's own window length", () => {
  assert.equal(windowLabel(18_000), "5h")
  assert.equal(windowLabel(604_800), "wk")
  assert.equal(windowLabel(172_800), "wk")
  assert.equal(windowLabel(2_592_000), "mo")
  assert.equal(windowLabel(5_184_000), "60d")
  assert.equal(windowLabel(undefined), undefined)
})

test("iso timestamps and epoch millis both parse", () => {
  assert.equal(asTime("2026-10-19T00:00:00.000Z"), Date.parse("2026-10-19T00:00:00.000Z"))
  assert.equal(asTime(1_792_000_000_000), 1_792_000_000_000)
  assert.equal(asTime("not a date"), undefined)
  assert.equal(asTime(null), undefined)
})

test("accounts that would render the same name use their stored label", () => {
  const accounts = [
    account({ key: "a", label: "quickfrontapp", storedLabel: "app" }),
    account({ key: "b", label: "quickfrontco", storedLabel: "co" }),
    account({ key: "c", label: "quickfrontapp", storedLabel: "app", integrationID: "opencode" }),
    account({ key: "d", label: "solo" }),
  ]
  const labels = buildLabels(accounts, 10)
  // "quickfrontapp" and "quickfrontco" both truncate to "quickfront", so the
  // first two fall back to the stored label; the third shares the exact label.
  assert.equal(labels.get("a"), "gpt·app")
  assert.equal(labels.get("b"), "gpt·co")
  assert.equal(labels.get("c"), "oc·app")
  assert.equal(labels.get("d"), "solo")
})

test("collisions fall back to a provider tag when no stored label is usable", () => {
  const accounts = [
    account({ key: "a", label: "thesegunonakoya" }),
    account({ key: "b", label: "thesegunonakoya@gmail.com", integrationID: "opencode" }),
  ]
  const labels = buildLabels(accounts, 10)
  assert.equal(labels.get("a"), "gpt·these…")
  assert.equal(labels.get("b"), "oc·these…")
})

test("backoff grows but stays short enough for a live display", () => {
  assert.equal(nextBackoff(1), 10_000)
  assert.equal(nextBackoff(2), 20_000)
  assert.equal(nextBackoff(9), 60_000)
  assert.equal(nextBackoff(1, 5_000), 5_000)
  assert.equal(nextBackoff(1, 900_000), 60_000)
})

test("small helpers behave", () => {
  assert.equal(clamp(150, 0, 100), 100)
  assert.equal(localPart("me@example.com"), "me")
  assert.equal(localPart(undefined), undefined)
  assert.equal(shortTag("opencode"), "oc")
  assert.equal(shortTag("openai"), "gpt")
  assert.equal(truncate("abcdefgh", 4), "abc…")
  assert.equal(truncate("abc", 4), "abc")
  assert.equal(compactAge(4_000), "4s")
  assert.equal(compactAge(3 * 3_600_000), "3h")
})
