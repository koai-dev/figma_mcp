# Figma MCP Bridge

Plugin Figma + MCP server cục bộ để agent IDE (Codex, antigravity, ...) gọi trực tiếp vào Figma Desktop.

## Kiến trúc
- `plugin/` chạy trong Figma Desktop (ẩn UI) và kết nối WebSocket tới localhost.
- `server/` chạy MCP server qua stdio, bridge sang Figma qua WebSocket.

## Cách chạy
1. **Cài và chạy MCP server (dev)**
   ```bash
   cd server
   npm install
   npm run dev
   ```
   Mặc định server mở `ws://localhost:8765`.

   Nếu cần chạy bản build (để MCP client gọi `node dist/index.js`):
   ```bash
   npm run build
   node dist/index.js
   ```

2. **Import plugin vào Figma Desktop**
   - Figma → Plugins → Development → Import plugin from manifest…
   - Chọn file `manifest.json` ở root repo.

3. **Chạy plugin**
   - Figma → Plugins → Development → `Figma MCP Bridge`
   - Plugin sẽ tự kết nối tới server (UI ẩn).

## MCP client config (generic)
Nhiều MCP client dùng cấu trúc `command` + `args`. File mẫu ở `mcp-config.example.json`.

Ví dụ:
```json
{
  "mcpServers": {
    "figma": {
      "command": "node",
      "args": ["/ABS/PATH/figma_mcp/server/dist/index.js"],
      "env": {
        "FIGMA_MCP_PORT": "8765",
        "FIGMA_MCP_TIMEOUT_MS": "15000",
        "FIGMA_MCP_MAX_EVENTS": "200"
      }
    }
  }
}
```

## Biến môi trường
- `FIGMA_MCP_PORT` (mặc định `8765`)
- `FIGMA_MCP_TIMEOUT_MS` (mặc định `15000`)
- `FIGMA_MCP_MAX_EVENTS` (mặc định `200`)

Nếu đổi port, nhớ cập nhật trong `plugin/main.js` và `plugin/ui.html` cho khớp.

## Tools hiện có
Document & Selection:
- `get_document_info`
- `get_selection`
- `read_my_design`
- `get_node_info`
- `get_nodes_info`
- `set_focus`
- `set_selections`

Annotations:
- `get_annotations`
- `set_annotation`
- `set_multiple_annotations`
- `scan_nodes_by_types`

Read-only:
- `get_page_tree`
- `search_nodes`
- `export_png`
- `export_svg`
- `export_pdf`

Read/write:
- `create_shape`
- `create_rectangle`
- `create_frame`
- `create_text`
- `set_text`
- `update_style`

Modifying Text Content:
- `scan_text_nodes`
- `set_text_content`
- `set_multiple_text_contents`

Events buffer:
- `get_events`
- `clear_events`

Các event được bridge:
- `selectionchange`
- `currentpagechange`
- `documentchange`

## Ghi chú
- `export_png` trả về `dataUrl` base64.
- `export_svg` trả về `dataUrl` base64 và `svg` string.
- `export_pdf` trả về `dataUrl` base64.

## Ví dụ arguments
`get_selection`
```json
{ "depth": 1 }
```

`read_my_design`
```json
{}
```

`get_node_info`
```json
{ "nodeId": "123:456", "depth": 1 }
```

`get_nodes_info`
```json
{ "nodeIds": ["123:456", "123:789"], "depth": 1 }
```

`set_focus`
```json
{ "nodeId": "123:456" }
```

`set_selections`
```json
{ "nodeIds": ["123:456", "123:789"] }
```

`get_annotations`
```json
{ "includeAllPages": true, "limit": 50 }
```

`set_annotation`
```json
{ "nodeId": "123:456", "labelMarkdown": "**Spec:** Primary button", "categoryId": "design" }
```

`set_multiple_annotations`
```json
{
  "items": [
    { "nodeId": "123:456", "label": "Primary CTA" },
    { "nodeId": "123:789", "labelMarkdown": "_Secondary_", "replace": true }
  ]
}
```

`scan_nodes_by_types`
```json
{ "types": ["TEXT", "FRAME"], "limit": 100 }
```

`get_page_tree`
```json
{ "depth": 2 }
```

`search_nodes`
```json
{ "nameContains": "button", "types": ["TEXT", "RECTANGLE"], "limit": 20 }
```

`export_png`
```json
{ "nodeId": "123:456", "scale": 2 }
```

`export_svg`
```json
{ "nodeId": "123:456" }
```

`export_pdf`
```json
{ "nodeId": "123:456" }
```

`create_shape`
```json
{ "shape": "rectangle", "width": 160, "height": 48, "x": 100, "y": 80 }
```

`create_rectangle`
```json
{ "width": 200, "height": 120, "x": 40, "y": 40, "name": "Card" }
```

`create_frame`
```json
{ "width": 360, "height": 640, "x": 0, "y": 0, "name": "Mobile" }
```

`create_text`
```json
{ "characters": "Hello Figma", "fontSize": 16, "x": 24, "y": 24 }
```

`scan_text_nodes`
```json
{ "limit": 100, "chunkSize": 20, "offset": 0, "includeText": true }
```

`set_text_content`
```json
{ "nodeId": "123:789", "text": "Updated copy", "fontSize": 16 }
```

`set_multiple_text_contents`
```json
{
  "items": [
    { "nodeId": "123:789", "text": "Primary" },
    { "nodeId": "123:790", "text": "Secondary", "fontSize": 14 }
  ]
}
```

`set_text`
```json
{ "nodeId": "123:789", "characters": "Hello MCP", "fontSize": 16 }
```

`update_style`
```json
{ "nodeId": "123:456", "opacity": 0.8, "cornerRadius": 8 }
```
- `set_text` yêu cầu load font; nếu text có mixed fonts, hãy truyền `fontName`.
