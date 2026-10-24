// Map Pi get_session_stats responses to an ACP usage_update payload.
// Pure: returns null whenever Pi cannot give trustworthy numbers.

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function usageUpdateFromStats(stats) {
  const usage = stats?.contextUsage;
  if (!finite(usage?.tokens) || !finite(usage?.contextWindow)) return null;

  const meta = { pi: {} };
  if (finite(usage.percent)) meta.pi.percent = usage.percent;
  if (stats.tokens && finite(stats.tokens.total)) meta.pi.tokens = stats.tokens.total;
  if (!Object.keys(meta.pi).length) delete meta.pi;

  return {
    sessionUpdate: 'usage_update',
    used: usage.tokens,
    size: usage.contextWindow,
    ...(finite(stats.cost) ? { cost: { amount: stats.cost, currency: 'USD' } } : {}),
    ...(meta.pi ? { _meta: meta } : {}),
  };
}
