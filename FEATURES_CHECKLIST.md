# MCP Feature Checklist

Status mapping:
- [x] Implemented
- [ ] Not implemented
- [ ] Partial (noted in line)

## Document & Selection
- [x] get_document_info
- [x] get_selection
- [x] read_my_design
- [x] get_node_info
- [x] get_nodes_info
- [x] set_focus
- [x] set_selections

## Annotations
- [x] get_annotations
- [x] set_annotation
- [x] set_multiple_annotations
- [x] scan_nodes_by_types

## Prototyping & Connections
- [ ] get_reactions
- [ ] set_default_connector
- [ ] create_connections

## Creating Elements
- [x] create_rectangle
- [x] create_frame
- [x] create_text

## Modifying Text Content
- [x] scan_text_nodes
- [x] set_text_content
- [x] set_multiple_text_contents

## Auto Layout & Spacing
- [ ] set_layout_mode
- [ ] set_padding
- [ ] set_axis_align
- [ ] set_layout_sizing
- [ ] set_item_spacing

## Styling
- [ ] set_fill_color (partial: `update_style` can set fills)
- [ ] set_stroke_color (partial: `update_style` can set strokes)
- [ ] set_corner_radius (partial: `update_style` can set cornerRadius)

## Layout & Organization
- [ ] move_node
- [ ] resize_node
- [ ] delete_node
- [ ] delete_multiple_nodes
- [ ] clone_node

## Components & Styles
- [ ] get_styles
- [ ] get_local_components
- [ ] create_component_instance
- [ ] get_instance_overrides
- [ ] set_instance_overrides

## Export & Advanced
- [ ] export_node_as_image (partial: `export_png`, `export_svg`, `export_pdf` only)

## Connection Management
- [ ] join_channel

## MCP Prompts
- [ ] design_strategy
- [ ] read_design_strategy
- [ ] text_replacement_strategy
- [ ] annotation_conversion_strategy
- [ ] swap_overrides_instances
- [ ] reaction_to_connector_strategy
