// Unit tests run worker modules under Bun: stub the Workers runtime module they import.
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
}));
