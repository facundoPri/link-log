import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";

// Locally, cookies and Better Auth's trusted origin are bound to localhost; move 127.0.0.1 visits there.
if (window.location.hostname === "127.0.0.1")
  window.location.replace(window.location.href.replace("//127.0.0.1", "//localhost"));

const elem = document.getElementById("root")!;
const root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(elem))
  : createRoot(elem);
root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
