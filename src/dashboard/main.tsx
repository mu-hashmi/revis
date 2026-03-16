/** Dashboard browser entrypoint. */

import React from "react";
import { createRoot } from "react-dom/client";

import { DashboardApp } from "./app";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dashboard root element is missing");
}

createRoot(root).render(
  <React.StrictMode>
    <DashboardApp />
  </React.StrictMode>
);
