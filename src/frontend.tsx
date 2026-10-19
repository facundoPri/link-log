import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";

// Locally, cookies and Better Auth's trusted origin are bound to 127.0.0.1 (scripts/ports.ts); move localhost visits there.
if (window.location.hostname === "localhost")
  window.location.replace(window.location.href.replace("//localhost", "//127.0.0.1"));

const elem = document.getElementById("root")!;
const root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(elem))
  : createRoot(elem);
root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
