/**
 * Plan/usage normalisation.
 *
 * Shapes mirror what the official CLI renders in its usage overlay, so the
 * relay's numbers line up with what the customer sees on commandcode.ai:
 *
 *   windowLimits  { limited, fiveHour:{used,cap,resetAt}, weekly:{...} }
 *   sandboxMinutes{ usedMinutes, limitMinutes, resetAt }
 *   credits.credits{ monthlyCredits, purchasedCredits, freeCredits }
 *   summary       { totalCount, totalCost, periodBasis }
 *   whoami.orgLimits[]
 */

/** Monthly credits each plan grants, keyed by the upstream plan id. */
export const PLAN_CREDITS = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

/** Human names, matching the plan badges on the website. */
export const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-go-v1": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

const PLAN_KEYS = Object.keys(PLAN_CREDITS).sort((a, b) => b.length - a.length);

/** Upstream ids carry suffixes (`individual-go-v2`), so match by prefix. */
export function planInfoFor(planId) {
  if (!planId || typeof planId !== "string") return null;
  const normalized = planId.toLowerCase().replaceAll("_", "-");
  const key = PLAN_KEYS.find((candidate) => normalized.startsWith(candidate));
  if (!key) return { id: planId, name: planId, monthlyCredits: null };
  return { id: planId, name: PLAN_NAMES[key] ?? key, monthlyCredits: PLAN_CREDITS[key] ?? null };
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One usage window (`{used,cap,resetAt}`) with a derived percentage. */
export function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const used = Math.max(0, num(window.used));
  const cap = Math.max(0, num(window.cap));
  const resetAt = num(window.resetAt) || null;
  return {
    used,
    cap,
    remaining: cap > 0 ? Math.max(0, cap - used) : null,
    percent: cap > 0 ? Math.min(100, (used / cap) * 100) : 0,
    resetAt,
  };
}

function daysUntil(iso, now) {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86400000));
}

/**
 * Full usage view for one account: the plan badge, the overall credit bar, the
 * 5-hour and weekly windows, cloud minutes, and the studio link.
 */
export function summarizeUsage(data, { now = Date.now(), studioBase = "https://commandcode.ai" } = {}) {
  const creditsEnvelope = data?.credits ?? null;
  const credits = creditsEnvelope?.credits ?? null;
  const subscription = data?.subscription?.data ?? null;
  const summary = data?.summary ?? null;
  const whoami = data?.whoami ?? null;
  const errors = data?.errors ?? [];

  if (!credits && !subscription) {
    return { available: false, errors };
  }

  const planId = subscription?.planId ?? creditsEnvelope?.planId ?? null;
  const plan = planInfoFor(planId);

  const monthlyRemaining = Math.max(0, num(credits?.monthlyCredits));
  const purchasedRemaining = Math.max(0, num(credits?.purchasedCredits));
  const freeRemaining = Math.max(0, num(credits?.freeCredits));
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
  const totalSpent = Math.max(0, num(summary?.totalCost));

  // The website measures the bar against the plan allowance plus anything
  // bought or granted, falling back to spend when the plan is not active.
  const planCredits = plan?.monthlyCredits ?? null;
  const active = subscription?.status === "active";
  const totalPool =
    planCredits !== null
      ? (active ? Math.max(planCredits, monthlyRemaining) : 0) + purchasedRemaining + freeRemaining
      : totalSpent + totalRemaining;
  const hasCreditsInfo = totalRemaining > 0 || totalSpent > 0;
  const usagePercent = totalPool > 0 ? Math.min(100, ((totalPool - totalRemaining) / totalPool) * 100) : 0;

  const windows = creditsEnvelope?.windowLimits ?? null;
  const sandbox = creditsEnvelope?.sandboxMinutes ?? null;
  const sandboxAccess = creditsEnvelope?.sandboxAccess === true;

  const orgUser = whoami?.org?.login ?? whoami?.user?.userName ?? null;

  return {
    available: true,
    planId,
    planName: plan?.name ?? null,
    status: subscription?.status ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    daysLeft: daysUntil(subscription?.currentPeriodEnd, now),
    requests: Number.isFinite(Number(summary?.totalCount)) ? Number(summary.totalCount) : null,
    periodBasis: summary?.periodBasis ?? null,
    totalCost: totalSpent,
    credits: {
      monthlyRemaining,
      purchasedRemaining,
      freeRemaining,
      totalRemaining,
      totalSpent,
      totalPool,
      usagePercent,
      hasCreditsInfo,
    },
    extraCredits: purchasedRemaining + freeRemaining,
    windows: {
      limited: windows?.limited === true,
      fiveHour: normalizeWindow(windows?.fiveHour),
      weekly: normalizeWindow(windows?.weekly),
    },
    sandbox: sandbox
      ? {
          usedMinutes: Math.max(0, num(sandbox.usedMinutes)),
          limitMinutes: Math.max(0, num(sandbox.limitMinutes)),
          resetAt: num(sandbox.resetAt) || null,
          percent:
            num(sandbox.limitMinutes) > 0
              ? Math.min(100, (num(sandbox.usedMinutes) / num(sandbox.limitMinutes)) * 100)
              : 0,
        }
      : null,
    sandboxAccess,
    orgLimits: Array.isArray(whoami?.orgLimits) ? whoami.orgLimits : [],
    usageUrl: orgUser ? `${studioBase}/${orgUser}/settings/usage` : null,
    errors,
  };
}

/**
 * Credits-only summary, kept for `/v1/balance`, which downstream routers read.
 */
export function summarizeCredits(data) {
  const credits = data?.credits?.credits ?? null;
  const subscription = data?.subscription?.data ?? null;
  if (!credits && !subscription) {
    return { available: false, errors: data?.errors ?? [] };
  }
  const monthly = Math.max(0, Number(credits?.monthlyCredits ?? 0));
  const purchased = Math.max(0, Number(credits?.purchasedCredits ?? 0));
  const free = Math.max(0, Number(credits?.freeCredits ?? 0));
  return {
    available: true,
    monthlyCredits: monthly,
    purchasedCredits: purchased,
    freeCredits: free,
    totalCredits: monthly + purchased + free,
    planId: subscription?.planId ?? data?.credits?.planId ?? null,
    status: subscription?.status ?? null,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    windowLimits: data?.credits?.windowLimits ?? null,
    errors: data?.errors ?? [],
  };
}
