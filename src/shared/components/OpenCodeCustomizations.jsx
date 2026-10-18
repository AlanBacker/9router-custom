"use client";
import { useEffect } from "react";
import pool from "../../../custom/browser/opencode-pool-ui.js";
import proxy from "../../../custom/browser/opencode-public-proxy-ui.js";
import paid from "../../../custom/browser/opencode-paid-egress-ui.js";
export default function OpenCodeCustomizations() {
  useEffect(() => { pool.install(window); proxy.install(window); paid.install(window); }, []);
  return null;
}
