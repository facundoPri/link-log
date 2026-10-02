import { createApp } from "./http/app";
import { cleanupBrowser } from "./browser";
import { dispatch, recover } from "./jobs";
import { LinkWorkflow } from "./workflow";
export { LinkWorkflow };

const app = createApp();

export default {
  fetch: app.fetch,
  queue: dispatch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recover(env));
    ctx.waitUntil(cleanupBrowser(env));
  },
} satisfies ExportedHandler<Env, { id: string }>;
