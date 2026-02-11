import { WebSocketServer, WebSocket } from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env.FIGMA_MCP_PORT || 8765);
const REQUEST_TIMEOUT_MS = Number(process.env.FIGMA_MCP_TIMEOUT_MS || 15000);
const MAX_EVENTS = Number(process.env.FIGMA_MCP_MAX_EVENTS || 200);

let activeSocket: WebSocket | null = null;
let socketId = 0;

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
>();

const eventBuffer: Array<{
  id: string;
  event: string;
  payload: unknown;
  timestamp: number;
}> = [];

function pushEvent(entry: { id: string; event: string; payload: unknown; timestamp: number }) {
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENTS) {
    eventBuffer.splice(0, eventBuffer.length - MAX_EVENTS);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  const id = ++socketId;
  activeSocket = socket;

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (!message || typeof message.type !== "string") return;

      if (message.type === "response" && message.id) {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);

        if (message.error) {
          entry.reject(new Error(message.error.message || "Plugin error"));
        } else {
          entry.resolve(message.result);
        }
      } else if (message.type === "event" && message.event) {
        pushEvent({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          event: String(message.event),
          payload: message.payload,
          timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now()
        });
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
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    throw new Error("Figma plugin not connected. Open the plugin in Figma Desktop.");
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = { type: "request", id, method, params };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    activeSocket!.send(JSON.stringify(payload));
  });
}

function getEvents(params: Record<string, unknown>) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : eventBuffer.length;
  const since = typeof params.since === "number" ? params.since : null;
  const clear = params.clear === true;

  let events = eventBuffer;
  if (since !== null) {
    events = events.filter((event) => event.timestamp >= since);
  }
  if (limit < events.length) {
    events = events.slice(events.length - limit);
  }

  const result = {
    total: eventBuffer.length,
    returned: events.length,
    events
  };

  if (clear) eventBuffer.length = 0;
  return result;
}

function clearEvents() {
  const cleared = eventBuffer.length;
  eventBuffer.length = 0;
  return { cleared };
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
    name: "get_events",
    description: "Get recent Figma events captured by the bridge.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, description: "Max events to return" },
        since: { type: "number", description: "Only return events after this timestamp (ms)" },
        clear: { type: "boolean", description: "Clear buffer after returning" }
      },
      additionalProperties: false
    }
  },
  {
    name: "clear_events",
    description: "Clear buffered Figma events.",
    inputSchema: {
      type: "object",
      additionalProperties: false
    }
  }
];

const server = new Server(
  { name: "figma-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;

  try {
    if (name === "get_events") {
      return toTextResult(getEvents(args));
    }
    if (name === "clear_events") {
      return toTextResult(clearEvents());
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

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`figma-mcp server listening on ws://localhost:${PORT}`);
