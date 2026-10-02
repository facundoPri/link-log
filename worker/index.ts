import { handleApi } from "./app";
import { dispatch, recover } from "./jobs";
import { LinkWorkflow } from "./workflow";
export { LinkWorkflow };

export default {
  queue: dispatch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recover(env));
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // Static assets (the SPA shell and login screen) carry no library data.
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    return handleApi(request, env, ctx);
  },
} satisfies ExportedHandler<Env, { id: string }>;
