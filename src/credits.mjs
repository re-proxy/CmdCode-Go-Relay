/**
 * Normalizes the upstream plan/credits payloads into the shape both the admin
 * page and /v1/balance consume.
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
