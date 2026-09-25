const DEFAULT_ORIGINS = ["https://asphalt-rus.ru", "https://www.asphalt-rus.ru"];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 5;
const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function getAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getChatIds(env) {
  return String(env.TELEGRAM_CHAT_IDS || "")
    .split(",")
    .map((chatId) => chatId.trim())
    .filter(Boolean);
}

function getOriginState(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return { origin: null, allowed: true };
  return { origin, allowed: getAllowedOrigins(env).includes(origin) };
}

function jsonResponse(data, status, origin) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function appendFields(value, prefix, lines, depth = 0) {
  if (lines.length >= 60 || depth > 4 || value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFields(item, `${prefix}[${index + 1}]`, lines, depth + 1));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, nested]) => {
      appendFields(nested, prefix ? `${prefix}.${key}` : key, lines, depth + 1);
    });
    return;
  }
  lines.push(`<b>${escapeHtml(prefix)}:</b> ${escapeHtml(String(value).slice(0, 1500))}`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildMessage(payload, files) {
  const lines = ["<b>Новая заявка с сайта</b>"];
  const data = { ...payload };
  const meta = data.meta;
  const fileMetadata = data.files;
  delete data.meta;
  delete data.files;
  if (payload.source) lines.push(`<b>Тип заявки:</b> ${escapeHtml(payload.source)}`);
  appendFields(data, "Поля", lines);
  appendFields(meta, "Метаданные", lines);
  if (files.length) {
    lines.push(`<b>Файлы:</b> ${escapeHtml(files.map((file, index) => `${index + 1}. ${file.name} (${formatBytes(file.size)})`).join(", "))}`);
  } else if (Array.isArray(fileMetadata) && fileMetadata.length) {
    lines.push(`<b>Файлы:</b> ${escapeHtml(fileMetadata.map((file) => file.name || "без имени").join(", "))}`);
  }
  let message = "";
  for (const line of lines) {
    const next = message ? `${message}\n${line}` : line;
    if (next.length > 3900) break;
    message = next;
  }
  return message;
}

function validateFiles(files) {
  if (files.length > MAX_FILES) return "Too many files";
  if (files.some((file) => file.size > MAX_FILE_SIZE)) return "File is too large";
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_FILE_SIZE) return "Files are too large";
  return "";
}

async function parseRequest(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_TOTAL_FILE_SIZE + 1024 * 1024) throw new Error("Request is too large");
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const rawPayload = form.get("payload");
    if (typeof rawPayload !== "string") throw new Error("Payload is missing");
    const payload = JSON.parse(rawPayload);
    const files = form.getAll("files").filter((value) => value && typeof value.size === "number");
    return { payload, files };
  }
  return { payload: await request.json(), files: [] };
}

async function callTelegram(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body });
  if (!response.ok) throw new Error("Telegram request failed");
  const result = await response.json();
  if (!result.ok) throw new Error("Telegram request failed");
}

async function sendText(token, chatId, text) {
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: "true"
  });
  await callTelegram(token, "sendMessage", body);
}

async function sendFile(token, chatId, file, index) {
  const body = new FormData();
  body.append("chat_id", chatId);
  body.append("caption", "Файл к заявке");
  body.append("document", new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }), file.name || `lead-file-${index + 1}`);
  await callTelegram(token, "sendDocument", body);
}

export default {
  async fetch(request, env) {
    const { origin, allowed } = getOriginState(request, env);
    const path = new URL(request.url).pathname;
    if (request.method === "OPTIONS") {
      if (!allowed) return jsonResponse({ ok: false }, 403, origin);
      const headers = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      };
      if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers.Vary = "Origin";
      }
      return new Response(null, { status: 204, headers });
    }
    if (path !== "/api/lead" && path !== "/api/lead/") return jsonResponse({ ok: false }, 404, origin);
    if (request.method !== "POST") return jsonResponse({ ok: false }, 405, origin);
    if (!allowed) return jsonResponse({ ok: false }, 403, origin);

    const token = String(env.TELEGRAM_BOT_TOKEN || "");
    const chatIds = getChatIds(env);
    if (!token || !chatIds.length) return jsonResponse({ ok: false }, 500, origin);

    try {
      const { payload, files } = await parseRequest(request);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return jsonResponse({ ok: false }, 400, origin);
      const fileError = validateFiles(files);
      if (fileError) return jsonResponse({ ok: false, message: fileError }, 413, origin);
      const message = buildMessage(payload, files);
      for (const chatId of chatIds) {
        await sendText(token, chatId, message);
        for (let index = 0; index < files.length; index += 1) {
          await sendFile(token, chatId, files[index], index);
        }
      }
      return jsonResponse({ ok: true }, 200, origin);
    } catch {
      return jsonResponse({ ok: false, message: "Unable to process lead" }, 502, origin);
    }
  }
};
