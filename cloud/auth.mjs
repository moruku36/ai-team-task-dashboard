// Authorization gate. Default deny: access requires an injected callback that returns a VERIFIED owner principal.
// Nothing here reads headers, query strings, cookies, env flags, VERCEL=1, x-vercel identity or Origin.
// The production adapter (cryptographic session/token validation) is a pending approval/integration gate:
// until it is injected, every request is refused before any storage is touched.
export async function authorizeOwner(authorize, req) {
  if (typeof authorize !== 'function') return { status: 503, error: 'Authentication not configured' };
  let principal;
  try { principal = await authorize(req); } catch { return { status: 503, error: 'Authentication unavailable' }; }
  if (!principal || typeof principal !== 'object' || principal.verified !== true) return { status: 401, error: 'Authentication required' };
  if (principal.role !== 'owner' || typeof principal.subject !== 'string' || !principal.subject) return { status: 403, error: 'Owner required' };
  return { principal };
}
