"use client";
import { useEffect } from "react";
import pool from "../../../custom/browser/opencode-pool-ui.js";
import proxy from "../../../custom/browser/opencode-public-proxy-ui.js";
export default function OpenCodeCustomizations() {
  useEffect(() => { pool.install(window); proxy.install(window); }, []);
  return null;
}
