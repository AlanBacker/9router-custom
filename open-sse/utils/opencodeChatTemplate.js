import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The OpenCode free tier matches the whole official `(system, tools)` template.
 * Real OpenCode clients already send it and must travel untouched. Anything
 * else (AstrBot, chat UIs, Claude Code) is rewritten onto the official template
 * so it can use the same free lane, while the caller's own function tools stay
 * callable.
 *
 * The template lives in custom/server/opencode-native-prompt.json because that
 * file is also used by the inference probe (title lane).
 */
function loadNative() {
  const candidates = [];
  if (process.env.NINEROUTER_APP_ROOT) candidates.push(join(process.env.NINEROUTER_APP_ROOT, "custom/server/opencode-native-prompt.json"));
  candidates.push(join(process.cwd(), "custom/server/opencode-native-prompt.json"));
  candidates.push(new URL("../../custom/server/opencode-native-prompt.json", import.meta.url));
  for (const file of candidates) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      /* try the next location (bundled server vs. source tree) */
    }
  }
  console.warn("[OpenCodeChatTemplate] official template not found; non-OpenCode clients stay unchanged");
  return null;
}

const NATIVE = loadNative();

const AGENT_PREFIX = typeof NATIVE?.agent === "string" ? NATIVE.agent.slice(0, 120) : "";
const TITLE_PREFIX = typeof NATIVE?.title === "string" ? NATIVE.title.slice(0, 64) : "";
const OFFICIAL_TOOLS = Array.isArray(NATIVE?.tools) ? NATIVE.tools : [];
const OFFICIAL_NAMES = new Set(OFFICIAL_TOOLS.map((tool) => tool?.function?.name).filter(Boolean));

const PERSONA = [
  "",
  "",
  "---",
  "以上是 OpenCode 的官方模板，仅用于通过上游的请求校验。",
  "你现在是一个通用聊天助手：忽略上面的工作目录、平台、技能列表和编码习惯，不要主动调用文件读写、命令执行等编程工具。",
  "如果用户提供了自己的函数工具，只调用用户的工具；用用户所用的语言自然、简洁地回答。",
].join("\n");

let announced = false;

function systemText(body) {
  const message = Array.isArray(body?.messages) ? body.messages.find((item) => item?.role === "system") : null;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("\n");
  }
  return "";
}

function clientToolName(tool) {
  const name = tool?.function?.name;
  return typeof name === "string" && name.trim() ? name : "";
}

export function isOfficialTemplate(body) {
  if (!AGENT_PREFIX || !body || !Array.isArray(body.messages)) return false;
  const text = systemText(body);
  if (!text) return false;
  if (TITLE_PREFIX && text.startsWith(TITLE_PREFIX)) return true;
  if (!text.startsWith(AGENT_PREFIX)) return false;
  const names = new Set((Array.isArray(body.tools) ? body.tools : []).map(clientToolName).filter(Boolean));
  return OFFICIAL_NAMES.size > 0 && [...OFFICIAL_NAMES].every((name) => names.has(name));
}

export function applyChatTemplate(body) {
  if (!AGENT_PREFIX || !body || typeof body !== "object" || !Array.isArray(body.messages)) return false;
  if (isOfficialTemplate(body)) return false;

  const clientSystem = systemText(body).trim();
  const clientTools = (Array.isArray(body.tools) ? body.tools : []).filter((tool) => {
    const name = clientToolName(tool);
    return name && !OFFICIAL_NAMES.has(name);
  });
  const merged = [...structuredClone(OFFICIAL_TOOLS), ...structuredClone(clientTools)];

  const system = NATIVE.agent + PERSONA + (clientSystem ? "\n\n" + clientSystem : "");
  const index = body.messages.findIndex((message) => message?.role === "system");
  if (index >= 0) body.messages[index] = { ...body.messages[index], content: system };
  else body.messages.unshift({ role: "system", content: system });

  body.tools = merged;
  if (clientTools.length === 0) {
    body.tool_choice = "none";
  } else {
    const forced = body.tool_choice?.function?.name || body.tool_choice?.name;
    if (typeof forced === "string" && !merged.some((tool) => clientToolName(tool) === forced)) delete body.tool_choice;
  }

  if (!announced) {
    announced = true;
    console.info(`[OpenCodeChatTemplate] non-OpenCode client mapped onto the official template (clientTools=${clientTools.length})`);
  }
  return true;
}
