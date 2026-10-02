// The Workers runtime module does not exist under bun test; the workflow class is never run here.
import { mock } from "bun:test";
mock.module("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, env: {} }));
