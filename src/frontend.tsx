import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
const elem = document.getElementById("root")!;
const root = import.meta.hot
  ? (import.meta.hot.data.root ??= createRoot(elem))
  : createRoot(elem);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
