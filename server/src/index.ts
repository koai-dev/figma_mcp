import { WebSocketServer, WebSocket } from "ws";
import { promises as fs } from "fs";
import path from "path";
import http from "http";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.FIGMA_MCP_PORT || 8765);
const REQUEST_TIMEOUT_MS = Number(process.env.FIGMA_MCP_TIMEOUT_MS || 15000);
const MAX_EVENTS = Number(process.env.FIGMA_MCP_MAX_EVENTS || 200);
const MCP_PATH = process.env.FIGMA_MCP_MCP_PATH || "/mcp";
const TRANSPORT_MODE = (process.env.FIGMA_MCP_TRANSPORT || "both").toLowerCase();
const ENABLE_STDIO = TRANSPORT_MODE === "stdio" || TRANSPORT_MODE === "both";
const ENABLE_MCP_HTTP = TRANSPORT_MODE === "http" || TRANSPORT_MODE === "both";

let activeSocket: WebSocket | null = null;
let socketId = 0;
let activeChannel = "default";
const channels = new Set<string>(["default"]);
type QueuedRequest = {
  type: "request";
  id: string;
  method: string;
  params: Record<string, unknown>;
  channel?: string;
};

const requestQueue: Array<QueuedRequest> = [];

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();

const mcpHttpSessions = new Map<
  string,
  {
    transport: StreamableHTTPServerTransport;
    server: Server;
  }
>();

const eventBuffer: Array<{
  id: string;
  event: string;
  payload: unknown;
  timestamp: number;
  channel: string;
}> = [];

function pushEvent(entry: {
  id: string;
  event: string;
  payload: unknown;
  timestamp: number;
  channel: string;
}) {
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENTS) {
    eventBuffer.splice(0, eventBuffer.length - MAX_EVENTS);
  }
}

function handleResponseMessage(message: any) {
  if (!message || typeof message.id !== "string") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(message.id);

  if (message.error) {
    entry.reject(new Error(message.error.message || "Plugin error"));
  } else {
    entry.resolve(message.result);
  }
}

function handleEventMessage(message: any, channelOverride?: string) {
  if (!message || typeof message.event !== "string") return;
  pushEvent({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    event: String(message.event),
    payload: message.payload,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    channel: channelOverride || activeChannel
  });
}

function getHeaderString(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
    return value[0];
  }
  return null;
}

function isInitializeRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null && "method" in body && (body as any).method === "initialize";
}

function writeJsonRpcError(
  res: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null
    })
  );
}

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!req.url) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (ENABLE_MCP_HTTP && url.pathname === MCP_PATH) {
    try {
      if (req.method === "POST") {
        const parsedBody = await parseBody(req);
        const sessionId = getHeaderString(req.headers["mcp-session-id"]);

        if (sessionId) {
          const session = mcpHttpSessions.get(sessionId);
          if (!session) {
            writeJsonRpcError(res, 404, -32001, `Session not found: ${sessionId}`);
            return;
          }
          await session.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          writeJsonRpcError(res, 400, -32000, "Bad Request: No valid session ID");
          return;
        }

        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            mcpHttpSessions.set(sid, { transport, server });
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (!sid) return;
          const session = mcpHttpSessions.get(sid);
          if (session) {
            mcpHttpSessions.delete(sid);
            void session.server.close();
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = getHeaderString(req.headers["mcp-session-id"]);
        if (!sessionId) {
          writeJsonRpcError(res, 400, -32000, "Bad Request: Missing MCP session ID");
          return;
        }
        const session = mcpHttpSessions.get(sessionId);
        if (!session) {
          writeJsonRpcError(res, 404, -32001, `Session not found: ${sessionId}`);
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      writeJsonRpcError(res, 405, -32000, `Method ${req.method || "UNKNOWN"} not allowed`);
      return;
    } catch (error) {
      console.error("Error handling MCP HTTP request:", error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, "Internal server error");
      }
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/pull") {
    const next = requestQueue.shift();
    if (!next) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(next));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/push" || url.pathname === "/event")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const message = body ? JSON.parse(body) : {};
        if (url.pathname === "/push") {
          handleResponseMessage(message);
        } else {
          handleEventMessage(message, activeChannel);
        }
        res.statusCode = 200;
        res.end();
      } catch {
        res.statusCode = 400;
        res.end();
      }
    });
    return;
  }

  res.statusCode = 404;
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket) => {
  const id = ++socketId;
  activeSocket = socket;

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (!message || typeof message.type !== "string") return;

      if (message.type === "response") {
        handleResponseMessage(message);
      } else if (message.type === "event") {
        handleEventMessage(message, activeChannel);
      }
    } catch {
      // Ignore malformed messages
    }
  });

  socket.on("close", () => {
    if (activeSocket === socket) activeSocket = null;
    // Fail all pending requests when plugin disconnects
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error("Plugin disconnected"));
    }
  });

  socket.send(
    JSON.stringify({ type: "ready", server: "figma-mcp", version: "0.1.0", connectionId: id })
  );
});

async function sendToPlugin(method: string, params: Record<string, unknown>) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload: QueuedRequest = { type: "request", id, method, params, channel: activeChannel };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(JSON.stringify(payload));
    } else {
      requestQueue.push(payload);
    }
  });
}

function getEvents(params: Record<string, unknown>) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : eventBuffer.length;
  const since = typeof params.since === "number" ? params.since : null;
  const clear = params.clear === true;
  const channel = typeof params.channel === "string" ? params.channel : null;

  let events = eventBuffer;
  if (channel) {
    events = events.filter((event) => event.channel === channel);
  }
  if (since !== null) {
    events = events.filter((event) => event.timestamp >= since);
  }
  if (limit < events.length) {
    events = events.slice(events.length - limit);
  }

  const result = {
    channel: channel || activeChannel,
    total: eventBuffer.length,
    returned: events.length,
    events
  };

  if (clear) eventBuffer.length = 0;
  return result;
}

function clearEvents(params: Record<string, unknown> = {}) {
  const channel = typeof params.channel === "string" ? params.channel : null;
  if (!channel) {
    const cleared = eventBuffer.length;
    eventBuffer.length = 0;
    return { cleared };
  }
  const before = eventBuffer.length;
  for (let i = eventBuffer.length - 1; i >= 0; i -= 1) {
    if (eventBuffer[i].channel === channel) {
      eventBuffer.splice(i, 1);
    }
  }
  return { cleared: before - eventBuffer.length, channel };
}

function toTextResult(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function listChannels() {
  const counts: Record<string, number> = {};
  for (const event of eventBuffer) {
    counts[event.channel] = (counts[event.channel] || 0) + 1;
  }
  return {
    activeChannel,
    channels: Array.from(channels.values()),
    counts
  };
}

function joinChannel(channel: string) {
  channels.add(channel);
  activeChannel = channel;
  return { channel: activeChannel };
}

function leaveChannel(channel: string, clear: boolean) {
  if (channel !== "default") {
    channels.delete(channel);
  }
  if (clear) {
    clearEvents({ channel });
  }
  if (activeChannel === channel) {
    activeChannel = "default";
  }
  return { activeChannel, left: channel };
}

function normalizeSnapshotInput(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input as Array<Record<string, unknown>>;
  if (input && typeof input === "object" && Array.isArray((input as any).nodes)) {
    return (input as any).nodes as Array<Record<string, unknown>>;
  }
  return [];
}

function diffSnapshots(params: Record<string, unknown>) {
  const beforeNodes = normalizeSnapshotInput(params.before);
  const afterNodes = normalizeSnapshotInput(params.after);
  const ignoreFields = Array.isArray(params.ignoreFields)
    ? params.ignoreFields.filter((item) => typeof item === "string")
    : ["children"];

  const beforeMap = new Map<string, Record<string, unknown>>();
  const afterMap = new Map<string, Record<string, unknown>>();

  for (const node of beforeNodes) {
    if (node && typeof node.id === "string") {
      beforeMap.set(node.id, node);
    }
  }
  for (const node of afterNodes) {
    if (node && typeof node.id === "string") {
      afterMap.set(node.id, node);
    }
  }

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, afterNode] of afterMap.entries()) {
    if (!beforeMap.has(id)) {
      added.push(afterNode);
    }
  }
  for (const [id, beforeNode] of beforeMap.entries()) {
    if (!afterMap.has(id)) {
      removed.push(beforeNode);
    }
  }

  for (const [id, beforeNode] of beforeMap.entries()) {
    const afterNode = afterMap.get(id);
    if (!afterNode) continue;
    const fields: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set<string>([
      ...Object.keys(beforeNode),
      ...Object.keys(afterNode)
    ]);

    for (const key of keys) {
      if (ignoreFields.includes(key)) continue;
      const beforeValue = (beforeNode as any)[key];
      const afterValue = (afterNode as any)[key];
      const beforeJson = JSON.stringify(beforeValue);
      const afterJson = JSON.stringify(afterValue);
      if (beforeJson !== afterJson) {
        fields[key] = { before: beforeValue, after: afterValue };
      }
    }

    if (Object.keys(fields).length > 0) {
      changed.push({ id, fields });
    }
  }

  return {
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added,
    removed,
    changed
  };
}

async function exportImageToFile(params: Record<string, unknown>) {
  const outputPath =
    typeof params.outputPath === "string"
      ? params.outputPath
      : typeof params.dir === "string" && typeof params.filename === "string"
        ? path.join(params.dir, params.filename)
        : null;

  if (!outputPath) {
    throw new Error("outputPath or dir+filename is required");
  }

  const exportParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (["outputPath", "dir", "filename"].includes(key)) continue;
    exportParams[key] = value;
  }

  const result = (await sendToPlugin("export_node_as_image", exportParams)) as any;
  if (!result || typeof result.dataUrl !== "string") {
    throw new Error("export_node_as_image did not return dataUrl");
  }

  const parts = result.dataUrl.split(",");
  if (parts.length < 2) {
    throw new Error("Invalid dataUrl");
  }
  const buffer = Buffer.from(parts[1], "base64");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);

  return {
    outputPath,
    bytes: buffer.length,
    format: result.format,
    mime: result.mime
  };
}

async function executeTool(name: string, args: Record<string, unknown>) {
  if (name === "get_events") return getEvents(args);
  if (name === "clear_events") return clearEvents(args);
  if (name === "join_channel") {
    const channel = typeof args.channel === "string" && args.channel.trim().length > 0 ? args.channel : null;
    if (!channel) throw new Error("channel must be a non-empty string");
    return joinChannel(channel);
  }
  if (name === "leave_channel") {
    const channel = typeof args.channel === "string" && args.channel.trim().length > 0 ? args.channel : null;
    if (!channel) throw new Error("channel must be a non-empty string");
    return leaveChannel(channel, args.clear === true);
  }
  if (name === "list_channels") return listChannels();
  if (name === "diff_snapshots") return diffSnapshots(args);
  if (name === "export_image_to_file") return exportImageToFile(args);

  return await sendToPlugin(name, args);
}

async function runBatchCalls(params: Record<string, unknown>) {
  if (!Array.isArray(params.calls)) {
    throw new Error("calls must be an array");
  }
  const stopOnError = params.stopOnError === true;

  const results = [];
  for (let i = 0; i < params.calls.length; i += 1) {
    const call = params.calls[i];
    if (!call || typeof call.name !== "string") {
      results.push({ index: i, ok: false, error: "Invalid call.name" });
      if (stopOnError) break;
      continue;
    }
    if (call.name === "batch_calls") {
      results.push({ index: i, ok: false, error: "Nested batch_calls is not supported" });
      if (stopOnError) break;
      continue;
    }
    try {
      const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
      const result = await executeTool(call.name, args);
      results.push({ index: i, ok: true, name: call.name, result });
    } catch (err) {
      results.push({
        index: i,
        ok: false,
        name: call.name,
        error: err instanceof Error ? err.message : String(err)
      });
      if (stopOnError) break;
    }
  }

  return {
    total: params.calls.length,
    returned: results.length,
    results
  };
}

const promptCatalog: Record<
  string,
  { description: string; messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }> }
> = {
  design_strategy: {
    description: "Best practices for working with Figma designs.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Bạn đang làm việc với Figma qua MCP. Hãy ưu tiên an toàn và kiểm soát:\n" +
              "1) Bắt đầu bằng `get_document_info` và `get_selection` để hiểu ngữ cảnh.\n" +
              "2) Dùng `read_my_design`, `get_node_info`, `get_page_tree`, `search_nodes` để đọc cấu trúc trước khi chỉnh sửa.\n" +
              "3) Khi chỉnh sửa, dùng thay đổi nhỏ, từng bước và xác nhận lại bằng `get_node_info`.\n" +
              "4) Với thao tác hàng loạt, dùng tool batch (`set_multiple_text_contents`, `set_multiple_annotations`).\n" +
              "5) Nếu cần hình ảnh, dùng `export_node_as_image` hoặc `export_png/svg/pdf`.\n" +
              "6) Luôn tránh thay đổi khi chưa rõ yêu cầu; hỏi lại nếu thiếu thông tin."
          }
        ]
      }
    ]
  },
  read_design_strategy: {
    description: "Best practices for reading Figma designs.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Mục tiêu: đọc hiểu thiết kế trước khi tác động.\n" +
              "1) Dùng `get_selection` hoặc `read_my_design` để lấy thông tin cụ thể của vùng đang chọn.\n" +
              "2) Dùng `get_page_tree` để nắm tổng quan cấu trúc page.\n" +
              "3) Dùng `search_nodes` để tìm nhanh theo tên/type.\n" +
              "4) Nếu cần chi tiết sâu, dùng `get_node_info` với `depth` lớn hơn.\n" +
              "5) Khi cần hình ảnh tham chiếu, dùng `export_node_as_image`."
          }
        ]
      }
    ]
  },
  text_replacement_strategy: {
    description: "Systematic approach for replacing text in Figma designs.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Chiến lược thay text an toàn:\n" +
              "1) Dùng `scan_text_nodes` với `chunkSize` nhỏ để liệt kê text nodes.\n" +
              "2) Lọc danh sách và chuẩn bị mapping id -> text mới.\n" +
              "3) Dùng `set_text_content` cho thay đổi đơn lẻ.\n" +
              "4) Dùng `set_multiple_text_contents` để batch update.\n" +
              "5) Nếu gặp mixed fonts, truyền `fontName` phù hợp."
          }
        ]
      }
    ]
  },
  annotation_conversion_strategy: {
    description: "Strategy for converting manual annotations to Figma's native annotations.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Chuyển annotation thủ công sang native annotations:\n" +
              "1) Dùng `scan_nodes_by_types` hoặc `search_nodes` để tìm targets.\n" +
              "2) Dùng `get_annotations` để kiểm tra annotation hiện có.\n" +
              "3) Dùng `set_annotation` cho từng node hoặc `set_multiple_annotations` cho batch.\n" +
              "4) Ưu tiên `labelMarkdown` để giữ định dạng nếu cần."
          }
        ]
      }
    ]
  },
  swap_overrides_instances: {
    description: "Strategy for transferring overrides between component instances in Figma.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Chuyển overrides giữa các instance:\n" +
              "1) Dùng `get_instance_overrides` trên instance nguồn.\n" +
              "2) Kiểm tra cấu trúc overrides trước khi áp dụng.\n" +
              "3) Dùng `set_instance_overrides` cho instance đích.\n" +
              "4) Nếu cần nhiều instance, lặp từng nodeId hoặc viết batch ở client."
          }
        ]
      }
    ]
  },
  reaction_to_connector_strategy: {
    description:
      "Strategy for converting Figma prototype reactions to connector lines using get_reactions and create_connections.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Chuyển prototype reactions sang connector lines (FigJam):\n" +
              "1) Dùng `get_reactions` để lấy danh sách reactions theo node/page.\n" +
              "2) Chọn 1 connector mẫu trong FigJam rồi gọi `set_default_connector`.\n" +
              "3) Tạo mapping từ reaction -> { fromNodeId, toNodeId }.\n" +
              "4) Dùng `create_connections` để vẽ hàng loạt connector.\n" +
              "Lưu ý: connectors chỉ khả dụng trong FigJam."
          }
        ]
      }
    ]
  }
};

const prompts = Object.keys(promptCatalog).map((name) => ({
  name,
  description: promptCatalog[name].description
}));

const tools: Tool[] = [
  {
    name: "get_document_info",
    description: "Get information about the current Figma document.",
    inputSchema: {
      type: "object",
      additionalProperties: false
    }
  },
  {
    name: "get_selection",
    description: "Get the current selection on the page.",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "number", description: "Child depth to include", minimum: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_my_design",
    description: "Get detailed node info about the current selection without params.",
    inputSchema: {
      type: "object",
      additionalProperties: false
    }
  },
  {
    name: "get_node_info",
    description: "Get detailed info for a specific node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" },
        depth: { type: "number", description: "Child depth to include", minimum: 0 }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "get_nodes_info",
    description: "Get detailed info for multiple nodes by id.",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } },
        depth: { type: "number", description: "Child depth to include", minimum: 0 }
      },
      required: ["nodeIds"],
      additionalProperties: false
    }
  },
  {
    name: "snapshot_nodes",
    description: "Snapshot multiple nodes for later diffing.",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } },
        depth: { type: "number", minimum: 0 }
      },
      required: ["nodeIds"],
      additionalProperties: false
    }
  },
  {
    name: "diff_snapshots",
    description: "Diff two snapshots created by snapshot_nodes.",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: ["object", "array"] },
        after: { type: ["object", "array"] },
        ignoreFields: { type: "array", items: { type: "string" } }
      },
      required: ["before", "after"],
      additionalProperties: false
    }
  },
  {
    name: "set_focus",
    description: "Select a node and scroll viewport to it.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_selections",
    description: "Set selection to multiple nodes and scroll viewport to show them.",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } }
      },
      required: ["nodeIds"],
      additionalProperties: false
    }
  },
  {
    name: "get_annotations",
    description: "Get annotations in the current document or a specific node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Optional node id to read annotations from" },
        pageId: { type: "string", description: "Optional page id to scan" },
        includeAllPages: { type: "boolean", description: "Scan all pages (may be slow)" },
        includeCategories: { type: "boolean", description: "Include annotation categories metadata" },
        limit: { type: "number", minimum: 1, description: "Max annotated nodes to return" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_annotation",
    description: "Create or update an annotation on a node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" },
        annotation: {
          type: "object",
          properties: {
            label: { type: "string" },
            labelMarkdown: { type: "string" },
            categoryId: { type: "string" },
            properties: { type: "array", items: { type: "object", additionalProperties: true } }
          },
          additionalProperties: false
        },
        label: { type: "string" },
        labelMarkdown: { type: "string" },
        categoryId: { type: "string" },
        properties: { type: "array", items: { type: "object", additionalProperties: true } },
        index: { type: "number", minimum: 0 },
        replace: { type: "boolean" },
        clear: { type: "boolean" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_multiple_annotations",
    description: "Batch create/update annotations on multiple nodes.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              annotation: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  labelMarkdown: { type: "string" },
                  categoryId: { type: "string" },
                  properties: { type: "array", items: { type: "object", additionalProperties: true } }
                },
                additionalProperties: false
              },
              annotations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    labelMarkdown: { type: "string" },
                    categoryId: { type: "string" },
                    properties: { type: "array", items: { type: "object", additionalProperties: true } }
                  },
                  additionalProperties: false
                }
              },
              label: { type: "string" },
              labelMarkdown: { type: "string" },
              categoryId: { type: "string" },
              properties: { type: "array", items: { type: "object", additionalProperties: true } },
              index: { type: "number", minimum: 0 },
              replace: { type: "boolean" },
              clear: { type: "boolean" }
            },
            required: ["nodeId"],
            additionalProperties: false
          }
        }
      },
      required: ["items"],
      additionalProperties: false
    }
  },
  {
    name: "scan_nodes_by_types",
    description: "Scan nodes by types (useful for finding annotation targets).",
    inputSchema: {
      type: "object",
      properties: {
        types: { type: "array", items: { type: "string" } },
        type: { type: "string" },
        limit: { type: "number", minimum: 1 },
        pageId: { type: "string" },
        parentId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_node",
    description: "Get a node by id.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" },
        depth: { type: "number", description: "Child depth to include", minimum: 0 }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "get_page_tree",
    description: "Get the current page tree (or a specific page by id).",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "Optional page node id" },
        depth: { type: "number", description: "Child depth to include", minimum: 0 }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_nodes",
    description: "Search nodes by name/type within a page or parent node.",
    inputSchema: {
      type: "object",
      properties: {
        nameContains: { type: "string", description: "Case-insensitive substring match" },
        type: { type: "string", description: "Single node type filter (e.g. TEXT)" },
        types: { type: "array", items: { type: "string" }, description: "Multiple node type filters" },
        limit: { type: "number", minimum: 1, description: "Max results (default 100)" },
        pageId: { type: "string", description: "Optional page node id" },
        parentId: { type: "string", description: "Optional parent node id" }
      },
      additionalProperties: false
    }
  },
  {
    name: "query_nodes",
    description: "Advanced query for nodes with multiple filters.",
    inputSchema: {
      type: "object",
      properties: {
        nameContains: { type: "string" },
        nameRegex: { type: "string" },
        nameRegexFlags: { type: "string" },
        type: { type: "string" },
        types: { type: "array", items: { type: "string" } },
        visible: { type: "boolean" },
        locked: { type: "boolean" },
        opacityMin: { type: "number" },
        opacityMax: { type: "number" },
        hasFills: { type: "boolean" },
        hasStrokes: { type: "boolean" },
        textContains: { type: "string" },
        limit: { type: "number", minimum: 1 },
        pageId: { type: "string" },
        parentId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "export_png",
    description: "Export a node as PNG and return a data URL.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" },
        scale: { type: "number", description: "Scale factor", minimum: 0.1 }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "export_svg",
    description: "Export a node as SVG and return dataUrl + svg string.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "export_pdf",
    description: "Export a node as PDF and return dataUrl.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Figma node id" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "create_shape",
    description: "Create a rectangle or ellipse on the current page.",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: ["rectangle", "ellipse"] },
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
        x: { type: "number" },
        y: { type: "number" },
        parentId: { type: "string", description: "Optional parent node id" },
        fillColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeWeight: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_rectangle",
    description: "Create a rectangle with position, size, and optional name.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
        parentId: { type: "string" },
        fillColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeWeight: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_frame",
    description: "Create a frame with position, size, and optional name.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
        parentId: { type: "string" },
        fillColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeWeight: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_text",
    description: "Create a text node with customizable font properties.",
    inputSchema: {
      type: "object",
      properties: {
        characters: { type: "string" },
        fontName: {
          type: "object",
          properties: {
            family: { type: "string" },
            style: { type: "string" }
          },
          additionalProperties: false
        },
        fontSize: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
        parentId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "scan_text_nodes",
    description: "Scan text nodes with chunking for large designs.",
    inputSchema: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        parentId: { type: "string" },
        limit: { type: "number", minimum: 1 },
        chunkSize: { type: "number", minimum: 1 },
        offset: { type: "number", minimum: 0 },
        includeText: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_text_content",
    description: "Set the text content of a single text node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        text: { type: "string" },
        fontName: {
          type: "object",
          properties: {
            family: { type: "string" },
            style: { type: "string" }
          },
          additionalProperties: false
        },
        fontSize: { type: "number" }
      },
      required: ["nodeId", "text"],
      additionalProperties: false
    }
  },
  {
    name: "set_multiple_text_contents",
    description: "Batch update multiple text nodes efficiently.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              text: { type: "string" },
              fontName: {
                type: "object",
                properties: {
                  family: { type: "string" },
                  style: { type: "string" }
                },
                additionalProperties: false
              },
              fontSize: { type: "number" }
            },
            required: ["nodeId", "text"],
            additionalProperties: false
          }
        }
      },
      required: ["items"],
      additionalProperties: false
    }
  },
  {
    name: "set_layout_mode",
    description: "Set the layout mode and wrap behavior of a frame.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        layoutMode: { type: "string", enum: ["NONE", "HORIZONTAL", "VERTICAL"] },
        layoutWrap: { type: "string", enum: ["NO_WRAP", "WRAP"] },
        primaryAxisAlignItems: {
          type: "string",
          enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]
        },
        counterAxisAlignItems: {
          type: "string",
          enum: ["MIN", "CENTER", "MAX", "BASELINE"]
        },
        primaryAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] },
        counterAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] },
        itemSpacing: { type: "number" },
        paddingTop: { type: "number" },
        paddingRight: { type: "number" },
        paddingBottom: { type: "number" },
        paddingLeft: { type: "number" }
      },
      required: ["nodeId", "layoutMode"],
      additionalProperties: false
    }
  },
  {
    name: "set_padding",
    description: "Set padding values for an auto-layout frame.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        top: { type: "number" },
        right: { type: "number" },
        bottom: { type: "number" },
        left: { type: "number" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_axis_align",
    description: "Set primary and counter axis alignment for auto-layout frames.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        primaryAxisAlignItems: {
          type: "string",
          enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]
        },
        counterAxisAlignItems: {
          type: "string",
          enum: ["MIN", "CENTER", "MAX", "BASELINE"]
        }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_layout_sizing",
    description: "Set horizontal and vertical sizing modes for auto-layout frames.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        horizontal: { type: "string", enum: ["HUG", "FILL", "FIXED"] },
        vertical: { type: "string", enum: ["HUG", "FILL", "FIXED"] },
        layoutSizingHorizontal: { type: "string", enum: ["HUG", "FILL", "FIXED"] },
        layoutSizingVertical: { type: "string", enum: ["HUG", "FILL", "FIXED"] },
        primaryAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] },
        counterAxisSizingMode: { type: "string", enum: ["FIXED", "AUTO"] }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_item_spacing",
    description: "Set distance between children in an auto-layout frame.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        itemSpacing: { type: "number" }
      },
      required: ["nodeId", "itemSpacing"],
      additionalProperties: false
    }
  },
  {
    name: "move_node",
    description: "Move a node to a new position.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "resize_node",
    description: "Resize a node with new dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        width: { type: "number" },
        height: { type: "number" }
      },
      required: ["nodeId", "width", "height"],
      additionalProperties: false
    }
  },
  {
    name: "delete_node",
    description: "Delete a node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "delete_multiple_nodes",
    description: "Delete multiple nodes at once efficiently.",
    inputSchema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } }
      },
      required: ["nodeIds"],
      additionalProperties: false
    }
  },
  {
    name: "clone_node",
    description: "Create a copy of an existing node with optional position offset.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        dx: { type: "number" },
        dy: { type: "number" },
        name: { type: "string" },
        appendToParent: { type: "boolean" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "get_styles",
    description: "Get information about local styles.",
    inputSchema: {
      type: "object",
      properties: {
        includeRemote: { type: "boolean", description: "Include team library styles" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_local_components",
    description: "Get information about local components.",
    inputSchema: {
      type: "object",
      properties: {
        includeAllPages: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_component_instance",
    description: "Create an instance of a component.",
    inputSchema: {
      type: "object",
      properties: {
        componentId: { type: "string" },
        variantId: { type: "string", description: "Optional component id for variant" },
        x: { type: "number" },
        y: { type: "number" },
        name: { type: "string" },
        parentId: { type: "string" }
      },
      required: ["componentId"],
      additionalProperties: false
    }
  },
  {
    name: "get_instance_overrides",
    description: "Extract override properties from a selected component instance.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_instance_overrides",
    description: "Apply extracted overrides to target instances.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        overrides: { type: "object", additionalProperties: true }
      },
      required: ["nodeId", "overrides"],
      additionalProperties: false
    }
  },
  {
    name: "set_fill_color",
    description: "Set the fill color of a node (RGBA).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        color: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        fillColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_stroke_color",
    description: "Set the stroke color and weight of a node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        color: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeColor: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" }
          },
          additionalProperties: false
        },
        strokeWeight: { type: "number" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_corner_radius",
    description: "Set the corner radius of a node (optionally per-corner).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        cornerRadius: { type: "number" },
        corners: {
          type: "object",
          properties: {
            topLeft: { type: "number" },
            topRight: { type: "number" },
            bottomLeft: { type: "number" },
            bottomRight: { type: "number" }
          },
          additionalProperties: false
        }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "get_reactions",
    description: "Get all prototype reactions from nodes.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        pageId: { type: "string" },
        includeAllPages: { type: "boolean" },
        limit: { type: "number", minimum: 1 },
        highlightOnly: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "set_default_connector",
    description: "Set a copied FigJam connector as the default connector style.",
    inputSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "create_connections",
    description: "Create FigJam connector lines between nodes.",
    inputSchema: {
      type: "object",
      properties: {
        connections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fromNodeId: { type: "string" },
              toNodeId: { type: "string" },
              fromMagnet: { type: "string" },
              toMagnet: { type: "string" },
              name: { type: "string" },
              parentId: { type: "string" },
              connectorLineType: { type: "string" },
              connectorStartStrokeCap: { type: "string" },
              connectorEndStrokeCap: { type: "string" },
              strokeWeight: { type: "number" },
              strokes: { type: "array" },
              dashPattern: { type: "array" },
              opacity: { type: "number" },
              style: { type: "object", additionalProperties: true }
            },
            required: ["fromNodeId", "toNodeId"],
            additionalProperties: false
          }
        }
      },
      required: ["connections"],
      additionalProperties: false
    }
  },
  {
    name: "export_node_as_image",
    description: "Export a node as an image (PNG, JPG, SVG, or PDF).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"] },
        scale: { type: "number", minimum: 0.1 },
        quality: { type: "number", minimum: 0, maximum: 1 },
        svgOutlineText: { type: "boolean" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "export_image_to_file",
    description: "Export a node and write the image to a local file path.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"] },
        scale: { type: "number", minimum: 0.1 },
        quality: { type: "number", minimum: 0, maximum: 1 },
        svgOutlineText: { type: "boolean" },
        outputPath: { type: "string" },
        dir: { type: "string" },
        filename: { type: "string" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "set_text",
    description: "Set characters on a text node (loads font if needed).",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        characters: { type: "string" },
        fontSize: { type: "number" },
        fontName: {
          type: "object",
          properties: {
            family: { type: "string" },
            style: { type: "string" }
          },
          additionalProperties: false
        }
      },
      required: ["nodeId", "characters"],
      additionalProperties: false
    }
  },
  {
    name: "update_style",
    description: "Update style properties like fills, strokes, opacity, cornerRadius.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        name: { type: "string" },
        visible: { type: "boolean" },
        locked: { type: "boolean" },
        opacity: { type: "number" },
        fills: { type: ["array", "string", "object", "null"] },
        strokes: { type: ["array", "string", "object", "null"] },
        strokeWeight: { type: "number" },
        cornerRadius: { type: "number" }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "batch_calls",
    description: "Execute multiple tool calls with per-call error handling.",
    inputSchema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              arguments: { type: "object", additionalProperties: true }
            },
            required: ["name"],
            additionalProperties: false
          }
        },
        stopOnError: { type: "boolean" }
      },
      required: ["calls"],
      additionalProperties: false
    }
  },
  {
    name: "get_events",
    description: "Get recent Figma events captured by the bridge.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, description: "Max events to return" },
        since: { type: "number", description: "Only return events after this timestamp (ms)" },
        clear: { type: "boolean", description: "Clear buffer after returning" },
        channel: { type: "string", description: "Optional channel filter" }
      },
      additionalProperties: false
    }
  },
  {
    name: "join_channel",
    description: "Join a specific channel to communicate with Figma.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" }
      },
      required: ["channel"],
      additionalProperties: false
    }
  },
  {
    name: "leave_channel",
    description: "Leave a channel and optionally clear its buffered events.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        clear: { type: "boolean" }
      },
      required: ["channel"],
      additionalProperties: false
    }
  },
  {
    name: "list_channels",
    description: "List known channels and event counts.",
    inputSchema: {
      type: "object",
      additionalProperties: false
    }
  },
  {
    name: "clear_events",
    description: "Clear buffered Figma events.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Optional channel to clear" }
      },
      additionalProperties: false
    }
  }
];

function createMcpServer() {
  const server = new Server(
    { name: "figma-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const prompt = promptCatalog[name];
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return {
      description: prompt.description,
      messages: prompt.messages
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;

    try {
      if (name === "get_events") {
        return toTextResult(getEvents(args));
      }
      if (name === "diff_snapshots") {
        return toTextResult(diffSnapshots(args));
      }
      if (name === "export_image_to_file") {
        return toTextResult(await exportImageToFile(args));
      }
      if (name === "batch_calls") {
        return toTextResult(await runBatchCalls(args));
      }
      if (name === "clear_events") {
        return toTextResult(clearEvents(args));
      }
      if (name === "join_channel") {
        const channel = typeof args.channel === "string" && args.channel.trim().length > 0 ? args.channel : null;
        if (!channel) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "channel must be a non-empty string"
              }
            ]
          };
        }
        return toTextResult(joinChannel(channel));
      }
      if (name === "leave_channel") {
        const channel = typeof args.channel === "string" && args.channel.trim().length > 0 ? args.channel : null;
        if (!channel) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "channel must be a non-empty string"
              }
            ]
          };
        }
        const clear = args.clear === true;
        return toTextResult(leaveChannel(channel, clear));
      }
      if (name === "list_channels") {
        return toTextResult(listChannels());
      }

      const result = await sendToPlugin(name, args);
      return toTextResult(result);
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err)
          }
        ]
      };
    }
  });

  return server;
}

if (ENABLE_STDIO) {
  const stdioServer = createMcpServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
}

httpServer.listen(PORT, () => {
  const transports: string[] = [];
  if (ENABLE_STDIO) transports.push("stdio");
  if (ENABLE_MCP_HTTP) transports.push(`streamable-http@${MCP_PATH}`);
  console.error(
    `figma-mcp server listening on http://localhost:${PORT} (mode=${TRANSPORT_MODE}, transports=${transports.join(",")})`
  );
});
