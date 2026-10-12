/** @jsxImportSource @opentui/solid */
//
// usage-monitor: shows the remaining subscription quota of every connected
// OpenCode Console and ChatGPT account, in a compact always-visible footer
// block and in a detailed dashboard opened with /use.
//
// Data sources (read-only GET requests, no credential writes, no token logs):
//   - OpenCode Console  GET {server}/api/go/status                     (5h / week / month meters)
//   - ChatGPT (Codex)   GET https://chatgpt.com/backend-api/wham/usage (5h / week rate-limit windows)
//
// Accounts whose provider exposes no usage API (API key providers such as
// Z.AI) are listed in the dashboard as "no usage API" instead of showing
// invented numbers.
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import {
  BACKOFF_START_MS,
  CLAIM_TTL_MS,
  CREDENTIAL_CACHE_MS,
  FORCE_MIN_AGE_MS,
  INTERVAL,
  LOW_CRIT,
  LOW_WARN,
  PERSIST_MIN_INTERVAL_MS,
  RECENT_USE_MS,
  REQUEST_TIMEOUT_MS,
  STALE_MS,
  SUPPORTED_ORDER,
  buildLabels,
  clamp,
  compactAge,
  countdown,
  dateOnly,
  localPart,
  nextBackoff,
  percent,
  remainingFromUsed,
  shortTag,
  titled,
  truncate,
  windowLabel,
  windowTitle,
  asNumber,
  asTime,
  type Account,
  type AccountStatus,
  type CreditLine,
  type CredentialRow,
  type MonitorOptions,
  type QuotaWindow,
  type SharedEntry,
  type Tier,
} from "./quota.ts"

/* ------------------------------------------------------------------ types */

/* -------------------------------------------------------------- constants */

/* -------------------------------------------------------------- utilities */

/* --------------------------------------------------------------- providers */

const INTEGRATIONS: Record<string, { name: string; providerIDs: string[] }> = {
  opencode: { name: "OpenCode Console", providerIDs: ["opencode", "opencode-go"] },
  openai: { name: "ChatGPT", providerIDs: ["openai", "chatgpt"] },
}

interface FetchResult {
  label?: string
  identity?: string
  plan?: string
  status: AccountStatus
  detail?: string
  windows: QuotaWindow[]
  credits: CreditLine[]
  error?: string
  retryAfterMs?: number
}

const AUTH_STATUSES = new Set([401, 403])

async function timedFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<{ status: number; body: any; retryAfterMs?: number }> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  init.signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { method: "GET", headers: init.headers, signal: controller.signal })
    const retryAfter = response.headers.get("retry-after")
    const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) : undefined
    let body: any
    try {
      if ((response.headers.get("content-type") ?? "").includes("json")) body = await response.json()
    } catch {
      body = undefined
    }
    return {
      status: response.status,
      body,
      retryAfterMs: retryAfterMs != null && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
    }
  } finally {
    clearTimeout(timer)
    init.signal.removeEventListener("abort", onAbort)
  }
}

/** OpenCode Console subscription meters. */
async function fetchOpencodeUsage(
  context: Context,
  credential: CredentialRow,
  signal: AbortSignal,
): Promise<FetchResult> {
  const value = credential.value
  if (!value || value.type !== "oauth" || typeof value.access !== "string") {
    return { status: "auth", windows: [], credits: [], error: "not an OAuth connection" }
  }
  const metadata = value.metadata ?? {}
  const server =
    typeof metadata.server === "string" ? metadata.server.replace(/\/+$/, "") : "https://opencode.ai/console"
  const headers: Record<string, string> = {
    authorization: `Bearer ${value.access}`,
    accept: "application/json",
    "user-agent": `opencode/${context.app.version}`,
  }
  if (typeof metadata.orgID === "string" && metadata.orgID) headers["x-org-id"] = metadata.orgID

  const result = await timedFetch(`${server}/api/go/status`, { headers, signal })
  if (AUTH_STATUSES.has(result.status)) {
    return { status: "auth", windows: [], credits: [], error: "sign in again to refresh" }
  }
  if (result.status === 404) {
    return {
      status: "none",
      windows: [],
      credits: [],
      error: "no subscription meters",
      label: localPart(typeof metadata.email === "string" ? metadata.email : undefined),
    }
  }
  if (result.status !== 200 || !result.body) {
    return {
      status: "error",
      windows: [],
      credits: [],
      error: `HTTP ${result.status}`,
      retryAfterMs: result.retryAfterMs,
    }
  }

  const body = result.body
  const access = body.access ?? {}
  const meters = access.meters ?? {}
  const windows: QuotaWindow[] = []
  const specs: Array<[string, string]> = [
    ["fiveHour", "5h"],
    ["week", "wk"],
    ["month", "mo"],
  ]
  for (const [meterKey, label] of specs) {
    const meter = meters[meterKey]
    if (!meter || typeof meter !== "object") continue
    const limit = asNumber(meter.limitMicroCents)
    const used = asNumber(meter.usedMicroCents)
    const resetsAt = asTime(meter.resetsAt)
    const remaining = limit != null && used != null ? remainingFromUsed(used, limit) : null
    windows.push({
      id: label,
      label,
      remaining,
      used: limit != null && used != null && limit > 0 ? clamp((used / limit) * 100, 0, 100) : null,
      resetsAt: resetsAt ?? null,
      note: meter.startsAt == null && meter.resetsAt == null && (used ?? 0) === 0 ? "not started" : undefined,
    })
  }
  if (windows.length === 0) {
    return { status: "none", windows: [], credits: [], error: "no subscription meters" }
  }

  const detailParts: string[] = []
  if (typeof metadata.orgName === "string" && metadata.orgName) detailParts.push(metadata.orgName)
  const periodEnd = asTime(access.endsAt)
  if (access.cancelAtPeriodEnd === true) detailParts.push(`cancels ${dateOnly(periodEnd)}`)
  else if (periodEnd != null) detailParts.push(`renews ${dateOnly(periodEnd)}`)

  return {
    status: "ok",
    label: localPart(typeof metadata.email === "string" ? metadata.email : undefined),
    identity: typeof metadata.email === "string" ? metadata.email : undefined,
    plan: titled(typeof body.product === "string" ? body.product : undefined),
    detail: detailParts.join(" · ") || undefined,
    windows,
    credits: [],
  }
}

/** ChatGPT (Codex) rate-limit windows and credit balance. */
async function fetchChatGPTUsage(
  context: Context,
  credential: CredentialRow,
  signal: AbortSignal,
): Promise<FetchResult> {
  const value = credential.value
  if (!value || value.type !== "oauth" || typeof value.access !== "string") {
    return { status: "auth", windows: [], credits: [], error: "not an OAuth connection" }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${value.access}`,
    accept: "application/json",
    "user-agent": `opencode/${context.app.version}`,
  }
  const accountID = value.metadata?.accountID
  if (typeof accountID === "string" && accountID) headers["chatgpt-account-id"] = accountID

  const result = await timedFetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal })
  if (AUTH_STATUSES.has(result.status)) {
    return { status: "auth", windows: [], credits: [], error: "sign in expired" }
  }
  if (result.status === 404) {
    return { status: "none", windows: [], credits: [], error: "usage not exposed for this plan" }
  }
  if (result.status !== 200 || !result.body) {
    return {
      status: "error",
      windows: [],
      credits: [],
      error: `HTTP ${result.status}`,
      retryAfterMs: result.retryAfterMs,
    }
  }

  const body = result.body
  const email = typeof body.email === "string" ? body.email : undefined
  const rateLimit = body.rate_limit ?? {}
  const windows: QuotaWindow[] = []
  const specs: Array<[string, string]> = [
    ["primary_window", "5h"],
    ["secondary_window", "wk"],
  ]
  for (const [field, fallbackLabel] of specs) {
    const window = rateLimit[field]
    if (!window || typeof window !== "object") continue
    const usedPercent = asNumber(window.used_percent)
    const label = windowLabel(asNumber(window.limit_window_seconds)) ?? fallbackLabel
    const resetsAt = asNumber(window.reset_at)
    windows.push({
      id: label,
      label,
      used: usedPercent != null ? clamp(usedPercent, 0, 100) : null,
      remaining: usedPercent != null ? clamp(100 - usedPercent, 0, 100) : null,
      resetsAt: resetsAt != null ? resetsAt * 1000 : null,
    })
  }
  if (rateLimit.limit_reached === true) {
    for (const window of windows) if (window.remaining == null) window.remaining = 0
  }

  const credits: CreditLine[] = []
  const creditInfo = body.credits
  if (creditInfo && creditInfo.unlimited === true) {
    credits.push({ label: "credits", value: "unlimited" })
  } else if (creditInfo && creditInfo.has_credits === true) {
    const balance = asNumber(creditInfo.balance)
    credits.push({ label: "credits", value: balance != null ? `$${(balance / 100).toFixed(2)}` : "available" })
  }

  const detailParts: string[] = []
  if (rateLimit.limit_reached === true) detailParts.push("rate limit reached")
  else if (typeof body.rate_limit_reached_type === "string" && body.rate_limit_reached_type)
    detailParts.push(String(body.rate_limit_reached_type))
  else if (body.rate_limit_reached_type && typeof body.rate_limit_reached_type === "object")
    detailParts.push("rate limit reached")

  return {
    status: "ok",
    label: localPart(email),
    identity: email,
    plan: titled(typeof body.plan_type === "string" ? body.plan_type : undefined),
    detail: detailParts.join(" · ") || undefined,
    windows,
    credits,
  }
}

type Fetcher = (context: Context, credential: CredentialRow, signal: AbortSignal) => Promise<FetchResult>

const FETCHERS: Record<string, Fetcher> = {
  opencode: fetchOpencodeUsage,
  openai: fetchChatGPTUsage,
}

/* --------------------------------------------------------------- monitor */

function createMonitor(context: Context) {
  const options = (context.options ?? {}) as MonitorOptions
  const intervals: Record<Tier, number> = {
    active: asNumber(options.intervals?.active) ?? INTERVAL.active,
    connected: asNumber(options.intervals?.connected) ?? INTERVAL.connected,
    idle: asNumber(options.intervals?.idle) ?? INTERVAL.idle,
  }
  const hidden = new Set(options.hidden ?? [])

  const [snapshot, setSnapshot] = createSignal<Snapshot>({ accounts: [], at: 0 })

  const byKey = new Map<string, Account>()
  const credentialValues = new Map<string, any>()
  const inFlight = new Map<string, Promise<void>>()
  const recentUse = new Map<string, number>()
  const lastRead = { at: 0 }
  const lastPersist = { at: 0 }
  const teardown = new AbortController()

  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const cache = (() => {
    try {
      const [state, update] = context.storage.store<{ accounts: Account[]; at: number }>("quota.cache", {
        initial: { accounts: [], at: 0 },
      })
      return { state, update }
    } catch {
      return undefined
    }
  })()

  // Live-shared snapshots: one instance fetches, every TUI shows the same value
  // within a second, so open panes never disagree.
  const instanceId = Math.random().toString(36).slice(2, 10)
  const shared = (() => {
    try {
      const [state, update] = context.storage.store<{ entries: Record<string, SharedEntry> }>("quota.shared", {
        initial: { entries: {} },
      })
      return { state, update }
    } catch {
      return undefined
    }
  })()

  function sharedEntry(key: string): SharedEntry | undefined {
    return shared?.state?.entries?.[key]
  }

  function writeShared(key: string, patch: Partial<SharedEntry>) {
    if (!shared) return
    void shared
      .update((draft) => {
        const entries = draft.entries ?? (draft.entries = {})
        const previous = entries[key]
        entries[key] = {
          status: patch.status ?? previous?.status ?? "loading",
          windows: patch.windows ?? previous?.windows ?? [],
          credits: patch.credits ?? previous?.credits ?? [],
          plan: patch.plan ?? previous?.plan,
          identity: patch.identity ?? previous?.identity,
          detail: patch.detail ?? previous?.detail,
          error: patch.error ?? previous?.error,
          fetchedAt: patch.fetchedAt ?? previous?.fetchedAt,
          claimedAt: patch.claimedAt,
          claimedBy: patch.claimedAt ? instanceId : undefined,
        }
      })
      .catch(() => {})
  }

  /** Take over a newer snapshot produced by another TUI instance. */
  function adoptShared(account: Account): boolean {
    const entry = sharedEntry(account.key)
    if (!entry || !entry.fetchedAt) return false
    if (entry.fetchedAt <= (account.fetchedAt ?? 0)) return false
    account.status = entry.status
    account.windows = Array.isArray(entry.windows) ? entry.windows : []
    account.credits = Array.isArray(entry.credits) ? entry.credits : []
    if (entry.plan) account.plan = entry.plan
    if (entry.identity) account.identity = entry.identity
    account.detail = entry.detail
    account.error = entry.error
    account.fetchedAt = entry.fetchedAt
    account.failureCount = 0
    account.backoffUntil = undefined
    return true
  }

  function sortAccounts(left: Account, right: Account): number {
    const rank = (value: string) => {
      const index = SUPPORTED_ORDER.indexOf(value)
      return index === -1 ? SUPPORTED_ORDER.length : index
    }
    if (rank(left.integrationID) !== rank(right.integrationID)) return rank(left.integrationID) - rank(right.integrationID)
    if (left.active !== right.active) return left.active ? -1 : 1
    return left.label.localeCompare(right.label)
  }

  function publish() {
    const accounts = Array.from(byKey.values())
    accounts.sort(sortAccounts)
    setSnapshot({ accounts, at: Date.now() })
    persist()
  }

  function persist() {
    if (!cache) return
    const now = Date.now()
    if (now - lastPersist.at < PERSIST_MIN_INTERVAL_MS) return
    lastPersist.at = now
    const accounts = Array.from(byKey.values()).map((account) => ({ ...account }))
    void cache
      .update((draft) => {
        draft.accounts = accounts
        draft.at = now
      })
      .catch(() => {})
  }

  /** Restore the last known snapshot so a fresh TUI has data with an honest age. */
  function hydrate() {
    const cached = cache?.state
    if (!cached || !Array.isArray(cached.accounts) || cached.accounts.length === 0) return
    for (const account of cached.accounts) {
      if (!account || typeof account.key !== "string" || typeof account.credentialID !== "string") continue
      if (hidden.has(account.credentialID)) continue
      byKey.set(account.key, {
        ...account,
        windows: Array.isArray(account.windows) ? account.windows : [],
        credits: Array.isArray(account.credits) ? account.credits : [],
        backoffUntil: undefined,
        tier: "connected",
      })
    }
    publish()
  }

  function resolveLabel(input: {
    credentialID: string
    integrationID: string
    storedLabel?: string
    email?: string
    fetchedLabel?: string
    current?: string
  }): string {
    const labels = options.labels ?? {}
    const candidates = [
      input.credentialID,
      `${input.integrationID}:${input.credentialID}`,
      input.email,
      localPart(input.email),
      input.storedLabel,
      input.fetchedLabel,
    ].filter((value): value is string => typeof value === "string" && value.length > 0)
    for (const key of candidates) {
      const mapped = labels[key]
      if (typeof mapped === "string" && mapped.trim() !== "") return mapped.trim()
    }
    return (
      input.fetchedLabel ??
      localPart(input.email) ??
      input.current ??
      input.storedLabel ??
      input.credentialID.slice(0, 8)
    )
  }

  function integrationForProvider(providerID: string): string | undefined {
    for (const [integrationID, definition] of Object.entries(INTEGRATIONS)) {
      if (definition.providerIDs.includes(providerID)) return integrationID
    }
    try {
      const providers = context.data.location.provider.list(context.location)
      const provider = providers?.find((entry) => entry.id === providerID)
      if (provider?.integrationID && INTEGRATIONS[provider.integrationID]) return provider.integrationID
    } catch {
      // provider data is best effort
    }
    return undefined
  }

  function currentIntegration(): string | undefined {
    const model = context.ui.model.current()
    if (!model?.providerID) return undefined
    return integrationForProvider(model.providerID)
  }

  /** Integration in use right now: a running session's provider first, then the prompt selection. */
  function activeIntegration(): string | undefined {
    try {
      for (const session of context.data.session.list() ?? []) {
        if (context.data.session.status(session.id) !== "running") continue
        const providerID = session.model?.providerID
        const integration = providerID ? integrationForProvider(providerID) : undefined
        if (integration) return integration
      }
    } catch {
      // session data is best effort
    }
    return currentIntegration()
  }

  function tierFor(account: Account, now: number, integration = activeIntegration()): Tier {
    const used = recentUse.get(account.integrationID) ?? 0
    if (account.active && (integration === account.integrationID || now - used < RECENT_USE_MS)) return "active"
    if (account.status === "auth" || account.status === "key") return "idle"
    return "connected"
  }

  /** The account the footer shows: the model in use, otherwise the most recently used one. */
  function focus(sessionID?: string): Account | undefined {
    const quotaAccounts = (integrationID: string) =>
      Array.from(byKey.values()).filter((entry) => entry.integrationID === integrationID && entry.status !== "key")
    const pick = (integrationID: string) => {
      const list = quotaAccounts(integrationID)
      return list.find((entry) => entry.active) ?? list[0]
    }
    // The model selected in the prompt is what the user is about to use; a
    // session model or recent activity is only a fallback.
    let integration = currentIntegration()
    if (!integration && sessionID) {
      try {
        const providerID = context.data.session.get(sessionID)?.model?.providerID
        integration = providerID ? integrationForProvider(providerID) : undefined
      } catch {
        integration = undefined
      }
    }
    if (!integration) {
      const recent = Array.from(recentUse.entries())
        .filter(([integrationID]) => INTEGRATIONS[integrationID])
        .sort((left, right) => right[1] - left[1])[0]
      integration = recent?.[0]
    }
    return integration ? pick(integration) : undefined
  }

  async function readCredentials(force = false): Promise<CredentialRow[]> {
    const now = Date.now()
    if (!force && now - lastRead.at < CREDENTIAL_CACHE_MS && credentialValues.size > 0) {
      return Array.from(byKey.values()).map((account) => ({
        id: account.credentialID,
        integrationID: account.integrationID,
        label: account.label,
        active: account.active,
        value: credentialValues.get(account.credentialID),
      }))
    }
    const entries = await context.client.credential.list()
    credentialValues.clear()
    const rows: CredentialRow[] = []
    for (const entry of entries ?? []) {
      const value = (entry as { value?: any }).value
      credentialValues.set(entry.id, value)
      rows.push({
        id: entry.id,
        integrationID: String(entry.integrationID),
        label: entry.label,
        active: entry.active === true,
        value,
      })
    }
    lastRead.at = Date.now()
    return rows
  }

  async function syncAccounts(force = false): Promise<void> {
    let rows: CredentialRow[]
    try {
      rows = await readCredentials(force)
    } catch {
      return
    }
    const seen = new Set<string>()
    for (const row of rows) {
      if (hidden.has(row.id)) continue
      const integrationID = row.integrationID
      const definition = INTEGRATIONS[integrationID]
      const key = `${integrationID}:${row.id}`
      seen.add(key)
      const email = typeof row.value?.metadata?.email === "string" ? row.value.metadata.email : undefined
      const expiresAt = row.value?.type === "oauth" ? asNumber(row.value.expires) : undefined
      const existing = byKey.get(key)
      if (existing) {
        existing.active = row.active
        existing.storedLabel = row.label
        existing.expiresAt = expiresAt
        if (email) existing.identity = email
        if (!definition) {
          existing.status = "key"
          existing.detail = "no usage API"
        }
        existing.label = resolveLabel({
          credentialID: existing.credentialID,
          integrationID,
          storedLabel: row.label,
          email: existing.identity,
          fetchedLabel: existing.label,
          current: existing.label,
        })
        continue
      }
      const account: Account = {
        key,
        credentialID: row.id,
        integrationID,
        integrationName: definition?.name ?? integrationID,
        label: "",
        storedLabel: row.label,
        identity: email ?? "",
        status: definition ? "loading" : "key",
        detail: definition ? undefined : "no usage API",
        windows: [],
        credits: [],
        active: row.active,
        tier: "connected",
        expiresAt,
      }
      account.label = resolveLabel({
        credentialID: row.id,
        integrationID,
        storedLabel: row.label,
        email,
      })
      byKey.set(key, account)
    }
    for (const key of Array.from(byKey.keys())) if (!seen.has(key)) byKey.delete(key)
    const now = Date.now()
    for (const account of byKey.values()) account.tier = tierFor(account, now)
    publish()
  }

  function refreshAccount(account: Account, force: boolean) {
    if (disposed) return
    const fetcher = FETCHERS[account.integrationID]
    if (!fetcher) {
      account.status = "key"
      account.detail = "no usage API"
      return
    }
    if (inFlight.has(account.key)) return
    const now = Date.now()
    const interval = intervals[account.tier]
    const entry = sharedEntry(account.key)
    // Another instance already fetched this account recently.
    if (!force && entry?.fetchedAt != null && now - entry.fetchedAt < interval) {
      adoptShared(account)
      return
    }
    // Another instance is fetching right now.
    if (!force && entry?.claimedAt != null && now - entry.claimedAt < CLAIM_TTL_MS) return
    const minAge = force ? FORCE_MIN_AGE_MS : interval
    if (now - (account.attemptedAt ?? 0) < minAge) return
    if (account.backoffUntil != null && now < account.backoffUntil) return
    const credential: CredentialRow = {
      id: account.credentialID,
      integrationID: account.integrationID,
      label: account.label,
      active: account.active,
      value: credentialValues.get(account.credentialID),
    }
    if (credential.value === undefined) {
      // Credentials not loaded yet; refresh them and let the next tick fetch.
      void readCredentials(true)
        .then(() => syncAccounts())
        .catch(() => {})
      return
    }
    account.attemptedAt = now
    writeShared(account.key, { claimedAt: now })
    const task = (async () => {
      try {
        const result = await fetcher(context, credential, teardown.signal)
        account.status = result.status
        account.windows = result.windows
        account.credits = result.credits
        account.error = result.error
        account.detail = result.detail
        if (result.plan) account.plan = result.plan
        if (result.identity) account.identity = result.identity
        account.label = resolveLabel({
          credentialID: account.credentialID,
          integrationID: account.integrationID,
          storedLabel: account.label,
          email: account.identity,
          fetchedLabel: result.label,
          current: account.label,
        })
        if (result.status === "ok") {
          account.fetchedAt = Date.now()
          account.backoffUntil = undefined
          account.failureCount = 0
          writeShared(account.key, {
            status: "ok",
            windows: account.windows,
            credits: account.credits,
            plan: account.plan,
            identity: account.identity,
            detail: account.detail,
            error: undefined,
            fetchedAt: account.fetchedAt,
          })
        } else if (result.status === "error") {
          account.failureCount = (account.failureCount ?? 0) + 1
          account.backoffUntil = Date.now() + nextBackoff(account.failureCount, result.retryAfterMs)
          writeShared(account.key, {})
        } else {
          account.backoffUntil = undefined
          writeShared(account.key, {
            status: result.status,
            windows: [],
            credits: [],
            detail: result.detail,
            error: result.error,
            fetchedAt: Date.now(),
          })
        }
      } catch {
        account.status = "error"
        account.error = "request failed"
        account.failureCount = (account.failureCount ?? 0) + 1
        account.backoffUntil = Date.now() + nextBackoff(account.failureCount)
        writeShared(account.key, {})
      } finally {
        inFlight.delete(account.key)
        account.tier = tierFor(account, Date.now())
        publish()
      }
    })()
    inFlight.set(account.key, task)
  }

  function forceRefreshAll() {
    for (const account of byKey.values()) refreshAccount(account, true)
  }

  function tick() {
    if (disposed) return
    const now = Date.now()
    const integration = activeIntegration()
    let adopted = false
    for (const account of byKey.values()) {
      account.tier = tierFor(account, now, integration)
      if (adoptShared(account)) adopted = true
      refreshAccount(account, false)
    }
    if (adopted) publish()
  }

  function ensureFresh(reason: "dashboard" | "event") {
    void (async () => {
      await syncAccounts(true)
      if (reason === "dashboard") forceRefreshAll()
    })()
  }

  async function start() {
    hydrate()
    await syncAccounts(true)
    const now = Date.now()
    for (const account of byKey.values()) {
      account.tier = tierFor(account, now)
      refreshAccount(account, false)
    }
    timer = setInterval(tick, 1000)
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    teardown.abort()
  }

  /** Refresh the account of the integration a finished request used. */
  function markUsed(sessionID: string) {
    try {
      const session = context.data.session.get(sessionID)
      const providerID = session?.model?.providerID
      const integration = providerID ? integrationForProvider(providerID) : undefined
      if (!integration) return
      recentUse.set(integration, Date.now())
      let refreshed = false
      for (const account of byKey.values()) {
        if (account.integrationID !== integration) continue
        if (account.active || !refreshed) {
          refreshAccount(account, true)
          refreshed = true
        }
      }
    } catch {
      // the session may already be gone
    }
  }

  return {
    start,
    stop,
    ensureFresh,
    syncAccounts,
    markUsed,
    snapshot,
    focus,
    activeIntegration,
    accounts: () => snapshot().accounts,
  }
}

type Monitor = ReturnType<typeof createMonitor>

/* ------------------------------------------------------------- components */

interface Snapshot {
  accounts: Account[]
  at: number
}

/** Colour for a remaining percentage: green, amber below 20%, red below 5%. */
function percentColor(context: Context, remaining: number | null | undefined) {
  if (remaining == null) return context.theme.text.muted
  if (remaining <= LOW_CRIT) return context.theme.text.feedback.error.base
  if (remaining <= LOW_WARN) return context.theme.text.feedback.warning.base
  return context.theme.text.feedback.success.base
}

function UsageFooter(props: { context: Context; monitor: Monitor; sessionID?: string }) {
  const [now, setNow] = createSignal(Date.now())
  const [width, setWidth] = createSignal(props.context.renderer.width)
  const timer = setInterval(() => setNow(Date.now()), 1000)
  const handleResize = (nextWidth: number) => {
    if (typeof nextWidth === "number" && Number.isFinite(nextWidth)) setWidth(nextWidth)
  }
  const renderer = props.context.renderer as unknown as {
    on?: (event: string, handler: (...args: any[]) => void) => void
    off?: (event: string, handler: (...args: any[]) => void) => void
  }
  try {
    renderer.on?.("resize", handleResize)
  } catch {
    // resize tracking is best effort
  }
  onCleanup(() => {
    clearInterval(timer)
    try {
      renderer.off?.("resize", handleResize)
    } catch {
      // ignore
    }
  })

  const account = createMemo(() => props.monitor.focus(props.sessionID))
  // Labels are sized to the terminal; accounts that would render identically
  // (long shared prefixes) fall back to their stored credential label, which is
  // short and distinguishing.
  const labels = createMemo(() =>
    buildLabels(props.monitor.accounts(), clamp(Math.floor(width() / 12), 8, 14)),
  )
  const age = createMemo(() => {
    const entry = account()
    return entry?.fetchedAt ? now() - entry.fetchedAt : undefined
  })
  // Sessions use the full footer width, so the line lives there. The start
  // screen uses a narrow centered composer where it would squeeze the folder
  // label, so it is left alone.
  const visible = createMemo(() => {
    try {
      return props.context.ui.router.current().type === "session"
    } catch {
      return true
    }
  })
  const compact = createMemo(() => width() < 130)

  // One line: the account in use, each exposed window with remaining % and the
  // time until that window resets (↺). Deliberately short so the built-in
  // footer row (folder, tokens, hints) keeps its space.
  return (
    <Show when={visible() && account()}>
      {(entry) => (
        <text wrapMode="word" fg={props.context.theme.text.muted}>
          <Show when={!compact()}>
            <span style={{ fg: props.context.theme.text.feedback.info.base }}>
              {labels().get(entry().key) ?? truncate(entry().label, 10)}
            </span>
          </Show>
          <Show
            when={entry().windows.length > 0}
            fallback={
              <span style={{ fg: props.context.theme.text.feedback.warning.base }}>
                {`${
                  compact() ? "" : " "
                }${
                  entry().status === "loading"
                    ? "…"
                    : entry().status === "auth"
                      ? "sign-in required"
                      : entry().status === "none"
                        ? "no meters"
                        : (entry().error ?? "--")
                }`}
              </span>
            }
          >
            <For each={entry().windows}>
              {(window, index) => (
                <span>
                  <Show when={index() > 0}>
                    <span style={{ fg: props.context.theme.text.muted }}> · </span>
                  </Show>
                  <span style={{ fg: props.context.theme.text.muted }}>{`${index() > 0 ? "" : " "}${window.label} `}</span>
                  <span style={{ fg: percentColor(props.context, window.remaining) }}>
                    {window.remaining != null && window.remaining <= LOW_CRIT ? "!" : ""}
                    {percent(window.remaining)}
                  </span>
                  <span style={{ fg: props.context.theme.text.muted }}>
                    {window.note === "not started" ? " —" : ` ${countdown(window.resetsAt, now())}`}
                  </span>
                </span>
              )}
            </For>
          </Show>
          <Show when={age() != null && (age() as number) > STALE_MS}>
            <span style={{ fg: props.context.theme.text.feedback.warning.base }}>{` · ${compactAge(age() as number)} ago`}</span>
          </Show>
        </text>
      )}
    </Show>
  )
}

function Bar(props: { context: Context; remaining: number | null; cells?: number }) {
  const cells = () => props.cells ?? 10
  const filled = () => (props.remaining == null ? 0 : clamp(Math.round((props.remaining / 100) * cells()), 0, cells()))
  // Returns a fragment of spans so the bar can live inside a <text> row.
  return (
    <>
      <span style={{ fg: percentColor(props.context, props.remaining) }}>{"█".repeat(filled())}</span>
      <span style={{ fg: props.context.theme.text.muted }}>{"░".repeat(cells() - filled())}</span>
    </>
  )
}

function AccountBlock(props: { context: Context; account: Account; now: number; detail: boolean }) {
  const statusText = () => {
    const account = props.account
    if (account.status === "ok") return account.active ? "connected · active" : "connected"
    if (account.status === "loading") return "loading"
    if (account.status === "auth") return account.error ?? "sign-in required"
    if (account.status === "none") return account.error ?? "no usage meters"
    if (account.status === "key") return "API key · no usage API"
    return account.error ?? "unavailable"
  }
  const statusColor = () =>
    props.account.status === "ok" ? props.context.theme.text.muted : props.context.theme.text.feedback.warning.base
  const identity = () => props.account.identity || props.account.label
  const updated = () =>
    props.account.fetchedAt ? `${compactAge(props.now - (props.account.fetchedAt as number))} ago` : "never"
  const expires = () => {
    const expiry = props.account.expiresAt
    if (!expiry) return undefined
    if (expiry <= props.now) return "token expired"
    return `token ${compactAge(expiry - props.now)} left`
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <text wrapMode="word">
        <span style={{ fg: props.account.active ? props.context.theme.text.feedback.info.base : props.context.theme.text.muted }}>
          {props.account.active ? "▸ " : "  "}
        </span>
        <span style={{ fg: props.context.theme.text.base }}>{identity()}</span>
        <span style={{ fg: props.context.theme.text.muted }}>
          {`  ${props.account.integrationName}${props.account.plan ? ` · ${props.account.plan}` : ""}`}
        </span>
      </text>
      <text wrapMode="word" fg={statusColor()}>
        <span>{"    "}</span>
        <span>{statusText()}</span>
        <span style={{ fg: props.context.theme.text.muted }}>{` · updated ${updated()}`}</span>
        <Show when={props.account.detail}>
          <span style={{ fg: props.context.theme.text.feedback.warning.base }}>{` · ${props.account.detail}`}</span>
        </Show>
      </text>
      <Show when={props.detail}>
        <text wrapMode="word" fg={props.context.theme.text.muted}>
          {`    ${props.account.detail ? `${props.account.detail} · ` : ""}${expires() ?? ""}`}
        </text>
      </Show>
      <For each={props.account.windows}>
        {(window) => (
          <text wrapMode="word">
            <span style={{ fg: props.context.theme.text.muted }}>{`    ${windowTitle(window.label).padEnd(8)}`}</span>
            <Bar context={props.context} remaining={window.remaining} />
            <span> </span>
            <span style={{ fg: percentColor(props.context, window.remaining) }}>{`${percent(window.remaining)} left`}</span>
            <span style={{ fg: props.context.theme.text.muted }}>
              {window.note ? ` · ${window.note}` : ` · resets in ${countdown(window.resetsAt, props.now)}`}
              {props.detail && window.used != null ? ` (${Math.round(window.used)}% used)` : ""}
            </span>
          </text>
        )}
      </For>
      <For each={props.account.credits}>
        {(credit) => (
          <text wrapMode="word">
            <span style={{ fg: props.context.theme.text.muted }}>{`    ${credit.label.padEnd(8)}`}</span>
            <span style={{ fg: props.context.theme.text.base }}>{credit.value}</span>
          </text>
        )}
      </For>
      <Show when={props.account.windows.length === 0 && props.account.status !== "loading"}>
        <text wrapMode="word" fg={props.context.theme.text.muted}>
          {props.account.status === "none"
            ? "    this account exposes no 5-hour, weekly or monthly quota"
            : props.account.status === "auth"
              ? "    sign in again in OpenCode (/connect) to restore usage"
              : props.account.status === "error"
                ? "    request failed; retrying with backoff"
                : ""}
        </text>
      </Show>
      <text> </text>
    </box>
  )
}

function UsageDashboard(props: { context: Context; monitor: Monitor }) {
  const [now, setNow] = createSignal(Date.now())
  const [detail, setDetail] = createSignal(false)
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  let scrollbox: { scrollBy?: (delta: number) => void } | undefined

  const accounts = createMemo(() => props.monitor.accounts())
  const quotaAccounts = createMemo(() => accounts().filter((account) => account.status !== "key"))
  const keyAccounts = createMemo(() => accounts().filter((account) => account.status === "key"))
  const stalest = createMemo(() => {
    const list = quotaAccounts().filter((account) => account.fetchedAt)
    if (list.length === 0) return undefined
    return Math.min(...list.map((account) => account.fetchedAt ?? 0))
  })
  const width = createMemo(() => clamp(props.context.renderer.width - 10, 40, 120))

  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 20,
    commands: [
      {
        id: "opencode-quota.dashboard.refresh",
        bind: "r",
        run: () => {
          void props.monitor.ensureFresh("dashboard")
        },
      },
      { id: "opencode-quota.dashboard.details", bind: "d", run: () => setDetail((value) => !value) },
      { id: "opencode-quota.dashboard.down", bind: "down", run: () => scrollbox?.scrollBy?.(1) },
      { id: "opencode-quota.dashboard.up", bind: "up", run: () => scrollbox?.scrollBy?.(-1) },
      { id: "opencode-quota.dashboard.page-down", bind: "pagedown", run: () => scrollbox?.scrollBy?.(8) },
      { id: "opencode-quota.dashboard.page-up", bind: "pageup", run: () => scrollbox?.scrollBy?.(-8) },
      {
        id: "opencode-quota.dashboard.close",
        bind: "escape",
        run: () => {
          props.context.ui.dialog.clear()
        },
      },
    ],
  }))

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={props.context.theme.surface("dialog").background.raised.base}
    >
      <text wrapMode="word">
        <span style={{ fg: props.context.theme.text.base }}>
          <strong>Usage</strong>
        </span>
        <span style={{ fg: props.context.theme.text.muted }}>
          {"  "}
          {`${quotaAccounts().length} quota account${quotaAccounts().length === 1 ? "" : "s"}`}
          {keyAccounts().length > 0 ? ` · ${keyAccounts().length} without usage API` : ""}
          {"  ·  "}
          {stalest() ? `updated ${compactAge(now() - (stalest() as number))} ago` : "loading"}
        </span>
      </text>
      <text fg={props.context.theme.text.muted} wrapMode="none" truncate>
        {"─".repeat(Math.min(width(), 120))}
      </text>
      <scrollbox
        ref={(value: { scrollBy?: (delta: number) => void } | undefined) => (scrollbox = value)}
        flexGrow={1}
      >
        <For each={quotaAccounts()}>
          {(account) => (
            <AccountBlock context={props.context} account={account} now={now()} detail={detail()} />
          )}
        </For>
        <Show when={keyAccounts().length > 0}>
          <text wrapMode="word" fg={props.context.theme.text.muted}>
            other connected providers
          </text>
          <For each={keyAccounts()}>
            {(account) => (
              <text wrapMode="word" fg={props.context.theme.text.muted}>
                {`  ${account.label} · ${account.integrationID} · API key · no usage or balance API exposed`}
              </text>
            )}
          </For>
        </Show>
        <Show when={detail()}>
          <text wrapMode="word" fg={props.context.theme.text.muted}>
            {"\nRemaining percentages come from each provider's own usage endpoint. OpenCode Console meters are derived from used/limit credit amounts; ChatGPT windows use the provider's used percentage. Nothing is estimated.\n"}
          </text>
        </Show>
      </scrollbox>
      <text fg={props.context.theme.text.muted} wrapMode="none" truncate>
        {"r refresh · d details · ↑/↓ scroll · esc close"}
      </text>
    </box>
  )
}

/* ------------------------------------------------------------------ entry */

export default Plugin.define({
  id: "opencode-quota",
  setup(context) {
    const monitor = createMonitor(context)
    const disposers: Array<() => void> = []

    void monitor.start().catch(() => {})

    disposers.push(
      // Footer status row, after the folder label and before OpenCode's
      // tokens/cost/hints. The label is dropped on narrow terminals so the
      // built-in content keeps its space.
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => <UsageFooter context={context} monitor={monitor} sessionID={input.sessionID} />,
      }),
    )

    context.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "opencode-quota.dashboard",
          title: "Show usage dashboard",
          description: "Remaining subscription quota for every connected account",
          group: "Usage",
          palette: true,
          slash: { name: "use" },
          run: () => {
            void monitor.ensureFresh("dashboard")
            context.ui.dialog.show(() => <UsageDashboard context={context} monitor={monitor} />)
            context.ui.dialog.set({ size: "xlarge", centered: true })
          },
        },
      ],
    }))

    for (const event of ["session.execution.succeeded", "session.usage.updated"] as const) {
      disposers.push(
        context.data.on(event, (payload) => {
          const sessionID = (payload as { data?: { sessionID?: string } })?.data?.sessionID
          if (typeof sessionID === "string") monitor.markUsed(sessionID)
        }),
      )
    }

    for (const event of ["credential.updated", "credential.switched", "integration.updated"] as const) {
      disposers.push(context.data.on(event, () => monitor.ensureFresh("event")))
    }

    return () => {
      monitor.stop()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
})
