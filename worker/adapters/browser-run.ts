/** A local Browser binding exists even though its Quick Actions RPC is unsupported. */
export function browserRunAvailable(env: Env) {
  const offline = (env.APP_ENV === "local" || env.APP_ENV === "test") && env.LOCAL_SERVICES_ONLY === "1";
  return !!env.BROWSER && !offline;
}

export function requireBrowserRun(env: Env) {
  if (!env.BROWSER) throw new Error("Automatic page extraction is unavailable: the browser service is not configured.");
  if (!browserRunAvailable(env))
    throw new Error("Automatic page extraction is unavailable in this local demo. Paste text, or use the connected demo.");
}
