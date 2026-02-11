# Figma MCP Bridge

Plugin Figma + MCP server cục bộ để agent IDE (Codex, antigravity, ...) gọi trực tiếp vào Figma Desktop.

## Kiến trúc
- `plugin/` chạy trong Figma Desktop (ẩn UI) và dùng HTTP polling tới localhost (tránh CSP chặn WebSocket).
- `server/` chạy MCP server qua stdio, bridge sang Figma qua HTTP (và WebSocket nếu dùng được).

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
- `query_nodes`
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

Auto Layout & Spacing:
- `set_layout_mode`
- `set_padding`
- `set_axis_align`
- `set_layout_sizing`
- `set_item_spacing`

Layout & Organization:
- `move_node`
- `resize_node`
- `delete_node`
- `delete_multiple_nodes`
- `clone_node`

Components & Styles:
- `get_styles`
- `get_local_components`
- `create_component_instance`
- `get_instance_overrides`
- `set_instance_overrides`

Styling:
- `set_fill_color`
- `set_stroke_color`
- `set_corner_radius`

Prototyping & Connections:
- `get_reactions`
- `set_default_connector`
- `create_connections`

Export & Advanced:
- `export_node_as_image`
- `export_image_to_file`

Connection Management:
- `join_channel`
- `leave_channel`
- `list_channels`

Batch & Utilities:
- `batch_calls`

Snapshots & Diff:
- `snapshot_nodes`
- `diff_snapshots`

MCP Prompts:
- `design_strategy`
- `read_design_strategy`
- `text_replacement_strategy`
- `annotation_conversion_strategy`
- `swap_overrides_instances`
- `reaction_to_connector_strategy`

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
- `export_node_as_image` trả về `dataUrl` base64 (và `svg` nếu format là SVG).
- `export_image_to_file` ghi file ra đường dẫn local do server cung cấp.
- `join_channel` đặt kênh hiện tại để gắn nhãn events trong `get_events`.
- `get_reactions` hỗ trợ `highlightOnly` (lọc best-effort).
- Nếu Figma CSP chặn WebSocket, bridge sẽ dùng HTTP polling (mặc định).

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

`query_nodes`
```json
{ "nameContains": "cta", "types": ["TEXT"], "textContains": "Buy", "limit": 50 }
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

`set_layout_mode`
```json
{
  "nodeId": "123:456",
  "layoutMode": "HORIZONTAL",
  "primaryAxisAlignItems": "CENTER",
  "counterAxisAlignItems": "CENTER",
  "itemSpacing": 12
}
```

`set_padding`
```json
{ "nodeId": "123:456", "top": 16, "right": 16, "bottom": 16, "left": 16 }
```

`set_axis_align`
```json
{ "nodeId": "123:456", "primaryAxisAlignItems": "SPACE_BETWEEN", "counterAxisAlignItems": "CENTER" }
```

`set_layout_sizing`
```json
{ "nodeId": "123:456", "horizontal": "HUG", "vertical": "FIXED" }
```

`set_item_spacing`
```json
{ "nodeId": "123:456", "itemSpacing": 8 }
```

`move_node`
```json
{ "nodeId": "123:456", "x": 120, "y": 80 }
```

`resize_node`
```json
{ "nodeId": "123:456", "width": 300, "height": 200 }
```

`delete_node`
```json
{ "nodeId": "123:456" }
```

`delete_multiple_nodes`
```json
{ "nodeIds": ["123:456", "123:789"] }
```

`clone_node`
```json
{ "nodeId": "123:456", "dx": 20, "dy": 20 }
```

`snapshot_nodes`
```json
{ "nodeIds": ["123:456", "123:789"], "depth": 0 }
```

`diff_snapshots`
```json
{ "before": { "nodes": [] }, "after": { "nodes": [] }, "ignoreFields": ["children"] }
```

`get_styles`
```json
{ "includeRemote": false }
```

`get_local_components`
```json
{ "includeAllPages": true }
```

`create_component_instance`
```json
{ "componentId": "123:456", "x": 100, "y": 200 }
```

`get_instance_overrides`
```json
{ "nodeId": "123:456" }
```

`set_instance_overrides`
```json
{ "nodeId": "123:456", "overrides": { "text": "Hello" } }
```

`set_fill_color`
```json
{ "nodeId": "123:456", "color": { "r": 1, "g": 0, "b": 0, "a": 1 } }
```

`set_stroke_color`
```json
{ "nodeId": "123:456", "color": { "r": 0, "g": 0, "b": 0, "a": 1 }, "strokeWeight": 2 }
```

`set_corner_radius`
```json
{ "nodeId": "123:456", "cornerRadius": 12 }
```

`get_reactions`
```json
{ "includeAllPages": true, "limit": 50, "highlightOnly": true }
```

`set_default_connector`
```json
{ "connectorId": "123:456" }
```

`create_connections`
```json
{
  "connections": [
    { "fromNodeId": "123:1", "toNodeId": "123:2" },
    { "fromNodeId": "123:3", "toNodeId": "123:4", "connectorLineType": "ELBOWED" }
  ]
}
```

`export_node_as_image`
```json
{ "nodeId": "123:456", "format": "PNG", "scale": 2 }
```

`export_image_to_file`
```json
{ "nodeId": "123:456", "format": "PNG", "scale": 2, "outputPath": "/tmp/export.png" }
```

`join_channel`
```json
{ "channel": "design-sync" }
```

`leave_channel`
```json
{ "channel": "design-sync", "clear": true }
```

`list_channels`
```json
{}
```

`batch_calls`
```json
{
  "calls": [
    { "name": "get_document_info" },
    { "name": "get_selection", "arguments": { "depth": 1 } }
  ]
}
```

MCP Prompts (dùng qua MCP `prompts/list` và `prompts/get`):
- `design_strategy`
- `read_design_strategy`
- `text_replacement_strategy`
- `annotation_conversion_strategy`
- `swap_overrides_instances`
- `reaction_to_connector_strategy`

`set_text`
```json
{ "nodeId": "123:789", "characters": "Hello MCP", "fontSize": 16 }
```

`update_style`
```json
{ "nodeId": "123:456", "opacity": 0.8, "cornerRadius": 8 }
```
- `set_text` yêu cầu load font; nếu text có mixed fonts, hãy truyền `fontName`.
