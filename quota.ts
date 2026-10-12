// pure helpers for opencode-quota: quota maths, formatting and account labels.
// no opencode imports here so the logic can be unit tested directly.

export type Tier = "active" | "connected" | "idle"

/** loading: first fetch pending, ok: has data, auth: sign-in/token problem,
 *  none: no subscription meters, error: request failed, key: no usage API. */
export type AccountStatus = "loading" | "ok" | "auth" | "none" | "error" | "key"

export interface QuotaWindow {
  id: string
  label: string
  /** Percentage of the window still available, 0..100. */
  remaining: number | null
  /** Percentage of the window already consumed, 0..100. */
  used: number | null
  resetsAt: number | null
  note?: string
}

export interface CreditLine {
  label: string
  value: string
}

export interface Account {
  key: string
  credentialID: string
  integrationID: string
  integrationName: string
  label: string
  /** Label stored with the credential, used to disambiguate truncated labels. */
  storedLabel?: string
  identity: string
  plan?: string
  status: AccountStatus
  detail?: string
  windows: QuotaWindow[]
  credits: CreditLine[]
  fetchedAt?: number
  attemptedAt?: number
  error?: string
  active: boolean
  tier: Tier
  expiresAt?: number
  backoffUntil?: number
  failureCount?: number
}

export interface Snapshot {
  accounts: Account[]
  at: number
}

export interface CredentialRow {
  id: string
  integrationID: string
  label: string
  active: boolean
  value: any
}

/** Snapshot of one account shared between every running TUI instance. */
export interface SharedEntry {
  status: AccountStatus
  windows: QuotaWindow[]
  credits: CreditLine[]
  plan?: string
  identity?: string
  detail?: string
  error?: string
  fetchedAt?: number
  claimedAt?: number
  claimedBy?: string
}

export const INTERVAL: Record<Tier, number> = { active: 5_000, connected: 15_000, idle: 60_000 }
export const RECENT_USE_MS = 5 * 60_000
export const FORCE_MIN_AGE_MS = 1_500
export const REQUEST_TIMEOUT_MS = 8_000
export const BACKOFF_START_MS = 10_000
export const BACKOFF_MAX_MS = 60_000
export const CLAIM_TTL_MS = 15_000
export const STALE_MS = 30_000
export const CREDENTIAL_CACHE_MS = 30_000
export const PERSIST_MIN_INTERVAL_MS = 20_000
export const LOW_WARN = 20
export const LOW_CRIT = 5
export const SUPPORTED_ORDER = ["opencode", "openai"]

export interface MonitorOptions {
  labels?: Record<string, string>
  hidden?: string[]
  intervals?: Partial<Record<Tier, number>>
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Parse an ISO date string or epoch milliseconds into epoch milliseconds. */
export function asTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Remaining percentage from used/limit credit amounts, as a 0..100 number. */
export function remainingFromUsed(used: number, limit: number): number | null {
  if (!(limit > 0)) return null
  return clamp((1 - used / limit) * 100, 0, 100)
}

export function percent(remaining: number | null | undefined): string {
  if (remaining == null) return "--"
  if (remaining >= 99.5) return "100%"
  if (remaining >= 10) return `${Math.round(remaining)}%`
  return `${remaining.toFixed(1)}%`
}

export function compactAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function countdown(resetsAt: number | null | undefined, now: number): string {
  if (!resetsAt) return "--"
  const diff = resetsAt - now
  if (diff <= 0) return "now"
  const seconds = Math.floor(diff / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

export function dateOnly(timestamp: number | undefined): string {
  if (!timestamp) return "--"
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function windowLabel(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined
  if (seconds <= 6 * 3600) return "5h"
  if (seconds <= 8 * 86400) return "wk"
  if (seconds <= 32 * 86400) return "mo"
  return `${Math.round(seconds / 86400)}d`
}

export function windowTitle(label: string): string {
  if (label === "5h") return "5-hour"
  if (label === "wk") return "weekly"
  if (label === "mo") return "monthly"
  return label
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

/** Local part of an email, used as the default readable label. */
export function localPart(email: string | undefined): string | undefined {
  if (!email) return undefined
  const at = email.indexOf("@")
  const local = at > 0 ? email.slice(0, at) : email
  return local.trim() || undefined
}

export function titled(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Short provider tag used to tell apart accounts with the same readable label. */
export function shortTag(integrationID: string): string {
  if (integrationID === "opencode") return "oc"
  if (integrationID === "openai") return "gpt"
  return integrationID.slice(0, 3)
}

/** Short display names; accounts that would render identically use their stored label. */
export function buildLabels(accounts: Account[], width: number): Map<string, string> {
  const groups = new Map<string, Account[]>()
  for (const entry of accounts) {
    const key = truncate(entry.label, width)
    const list = groups.get(key)
    if (list) list.push(entry)
    else groups.set(key, [entry])
  }
  const plan = new Map<string, string>()
  for (const list of groups.values()) {
    for (const entry of list) {
      if (list.length === 1) {
        plan.set(entry.key, truncate(entry.label, width))
        continue
      }
      const stored = entry.storedLabel ?? ""
      plan.set(
        entry.key,
        stored && stored.length <= 12 && !stored.includes("@")
          ? `${shortTag(entry.integrationID)}·${stored}`
          : `${shortTag(entry.integrationID)}·${truncate(entry.label, Math.max(4, width - 4))}`,
      )
    }
  }
  return plan
}

export function nextBackoff(failures: number, retryAfterMs?: number): number {
  const base =
    retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : BACKOFF_START_MS * Math.pow(2, Math.max(0, failures - 1))
  return Math.min(base, BACKOFF_MAX_MS)
  }
