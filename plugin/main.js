// Figma MCP Bridge - Plugin main thread
// This plugin runs a hidden UI to connect to a local MCP server via WebSocket.

const SERVER_URL = "http://localhost:8765";

figma.showUI(__html__, { visible: false, width: 1, height: 1 });
figma.ui.postMessage({ type: "config", serverUrl: SERVER_URL });

const MIXED = figma.mixed;
let defaultConnectorStyle = null;

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== "request") return;
  const { id, method, params } = msg;
  try {
    const result = await handleRequest(method, params || {});
    figma.ui.postMessage({ type: "response", id, result });
  } catch (err) {
    figma.ui.postMessage({
      type: "response",
      id,
      error: { message: err && err.message ? err.message : String(err) }
    });
  }
};

function emitEvent(event, payload) {
  figma.ui.postMessage({
    type: "event",
    event,
    payload,
    timestamp: Date.now()
  });
}

function summarizeDocChanges(changes) {
  return changes.map((change) => {
    const summary = { type: change.type };
    if ("id" in change && typeof change.id === "string") summary.id = change.id;
    if ("nodeId" in change && typeof change.nodeId === "string") summary.nodeId = change.nodeId;
    if ("properties" in change && Array.isArray(change.properties)) summary.properties = change.properties;
    return summary;
  });
}

function getNodeById(nodeId) {
  if (!nodeId || typeof nodeId !== "string") {
    throw new Error("nodeId is required");
  }
  const node = figma.getNodeById(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function getSceneNode(nodeId) {
  const node = getNodeById(nodeId);
  if (node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new Error("Expected a scene node, got DOCUMENT/PAGE");
  }
  return node;
}

function normalizePaints(value) {
  if (value === MIXED) return "mixed";
  return value;
}

function nodeToJSON(node, depth) {
  const data = {
    id: node.id,
    name: node.name,
    type: node.type
  };

  if ("visible" in node) data.visible = node.visible;
  if ("locked" in node) data.locked = node.locked;
  if ("x" in node) data.x = node.x;
  if ("y" in node) data.y = node.y;
  if ("width" in node) data.width = node.width;
  if ("height" in node) data.height = node.height;
  if ("rotation" in node) data.rotation = node.rotation;
  if ("opacity" in node) data.opacity = node.opacity;

  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    data.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if ("fills" in node) data.fills = normalizePaints(node.fills);
  if ("strokes" in node) data.strokes = normalizePaints(node.strokes);
  if ("strokeWeight" in node) data.strokeWeight = node.strokeWeight === MIXED ? "mixed" : node.strokeWeight;
  if ("cornerRadius" in node) data.cornerRadius = node.cornerRadius === MIXED ? "mixed" : node.cornerRadius;

  if (node.type === "TEXT") {
    data.characters = node.characters;
    data.fontName = node.fontName === MIXED ? "mixed" : node.fontName;
    data.fontSize = node.fontSize === MIXED ? "mixed" : node.fontSize;
    data.textAlignHorizontal = node.textAlignHorizontal;
    data.textAlignVertical = node.textAlignVertical;
  }

  if ("children" in node && depth > 0) {
    data.children = node.children.map((child) => nodeToJSON(child, depth - 1));
  }

  return data;
}

async function handleRequest(method, params) {
  switch (method) {
    case "get_document_info":
      return getDocumentInfo();
    case "get_selection":
      return getSelection(params);
    case "read_my_design":
      return readMyDesign();
    case "get_node_info":
      return getNodeInfo(params);
    case "get_nodes_info":
      return getNodesInfo(params);
    case "set_focus":
      return setFocus(params);
    case "set_selections":
      return setSelections(params);
    case "snapshot_nodes":
      return snapshotNodes(params);
    case "get_node":
      return getNode(params);
    case "get_annotations":
      return getAnnotations(params);
    case "set_annotation":
      return setAnnotation(params);
    case "set_multiple_annotations":
      return setMultipleAnnotations(params);
    case "scan_nodes_by_types":
      return scanNodesByTypes(params);
    case "export_png":
      return exportPng(params);
    case "export_svg":
      return exportSvg(params);
    case "export_pdf":
      return exportPdf(params);
    case "create_shape":
      return createShape(params);
    case "create_rectangle":
      return createRectangle(params);
    case "create_frame":
      return createFrame(params);
    case "create_text":
      return createText(params);
    case "scan_text_nodes":
      return scanTextNodes(params);
    case "set_text_content":
      return setTextContent(params);
    case "set_multiple_text_contents":
      return setMultipleTextContents(params);
    case "set_layout_mode":
      return setLayoutMode(params);
    case "set_padding":
      return setPadding(params);
    case "set_axis_align":
      return setAxisAlign(params);
    case "set_layout_sizing":
      return setLayoutSizing(params);
    case "set_item_spacing":
      return setItemSpacing(params);
    case "move_node":
      return moveNode(params);
    case "resize_node":
      return resizeNode(params);
    case "delete_node":
      return deleteNode(params);
    case "delete_multiple_nodes":
      return deleteMultipleNodes(params);
    case "clone_node":
      return cloneNode(params);
    case "get_styles":
      return getStyles(params);
    case "get_local_components":
      return getLocalComponents(params);
    case "create_component_instance":
      return createComponentInstance(params);
    case "get_instance_overrides":
      return getInstanceOverrides(params);
    case "set_instance_overrides":
      return setInstanceOverrides(params);
    case "set_fill_color":
      return setFillColor(params);
    case "set_stroke_color":
      return setStrokeColor(params);
    case "set_corner_radius":
      return setCornerRadius(params);
    case "get_reactions":
      return getReactions(params);
    case "set_default_connector":
      return setDefaultConnector(params);
    case "create_connections":
      return createConnections(params);
    case "export_node_as_image":
      return exportNodeAsImage(params);
    case "set_text":
      return setText(params);
    case "update_style":
      return updateStyle(params);
    case "get_page_tree":
      return getPageTree(params);
    case "search_nodes":
      return searchNodes(params);
    case "query_nodes":
      return queryNodes(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

function getAnnotations(params) {
  return getAnnotationsAsync(params);
}

async function getAnnotationsAsync(params) {
  const includeAllPages = params && params.includeAllPages === true;
  const includeCategories = params && params.includeCategories === true;
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : null;

  if (params && typeof params.nodeId === "string") {
    const node = getAnnotatableNode(params.nodeId);
    const result = {
      nodeId: node.id,
      annotations: node.annotations || []
    };
    if (includeCategories) {
      result.categories = await getAnnotationCategoriesSafe();
    }
    return result;
  }

  let pages = [];
  if (params && typeof params.pageId === "string") {
    const page = getNodeById(params.pageId);
    if (page.type !== "PAGE") throw new Error("pageId must be a PAGE node");
    pages = [page];
  } else if (includeAllPages) {
    await figma.loadAllPagesAsync();
    pages = figma.root.children;
  } else {
    pages = [figma.currentPage];
  }

  const nodes = [];
  for (const page of pages) {
    if (!("findAll" in page)) continue;
    const found = page.findAll((node) => supportsAnnotations(node) && node.annotations && node.annotations.length > 0);
    for (const node of found) {
      nodes.push({
        nodeId: node.id,
        pageId: page.id,
        name: node.name,
        type: node.type,
        annotations: node.annotations || []
      });
      if (limit && nodes.length >= limit) break;
    }
    if (limit && nodes.length >= limit) break;
  }

  const result = {
    pageCount: pages.length,
    nodeCount: nodes.length,
    nodes
  };

  if (includeCategories) {
    result.categories = await getAnnotationCategoriesSafe();
  }

  return result;
}

async function getAnnotationCategoriesSafe() {
  try {
    if (figma.annotations && figma.annotations.getAnnotationCategoriesAsync) {
      return await figma.annotations.getAnnotationCategoriesAsync();
    }
  } catch (err) {
    // ignore
  }
  return [];
}

function normalizeAnnotation(input) {
  if (!input || typeof input !== "object") {
    throw new Error("annotation must be an object");
  }
  const annotation = {};
  if (typeof input.label === "string") annotation.label = input.label;
  if (typeof input.labelMarkdown === "string") annotation.labelMarkdown = input.labelMarkdown;
  if (Array.isArray(input.properties)) annotation.properties = input.properties;
  if (typeof input.categoryId === "string") annotation.categoryId = input.categoryId;

  if (Object.keys(annotation).length === 0) {
    throw new Error("annotation must include label, labelMarkdown, properties, or categoryId");
  }
  return annotation;
}

function supportsAnnotations(node) {
  return node && typeof node === "object" && "annotations" in node;
}

function getAnnotatableNode(nodeId) {
  const node = getSceneNode(nodeId);
  if (!supportsAnnotations(node)) {
    throw new Error("Node type does not support annotations");
  }
  return node;
}

function setAnnotation(params) {
  const node = getAnnotatableNode(params.nodeId);
  if (params.clear === true) {
    node.annotations = [];
    return { nodeId: node.id, annotations: node.annotations };
  }

  const annotation = normalizeAnnotation(params.annotation || params);
  let annotations = Array.isArray(node.annotations) ? [...node.annotations] : [];

  if (params.replace === true) {
    annotations = [annotation];
  } else if (typeof params.index === "number" && params.index >= 0) {
    annotations[params.index] = annotation;
  } else {
    annotations.push(annotation);
  }

  node.annotations = annotations;
  return { nodeId: node.id, annotations: node.annotations };
}

function setMultipleAnnotations(params) {
  if (!Array.isArray(params.items)) {
    throw new Error("items must be an array");
  }

  const results = params.items.map((item) => {
    const node = getAnnotatableNode(item.nodeId);
    if (item.clear === true) {
      node.annotations = [];
      return { nodeId: node.id, annotations: node.annotations };
    }

    let annotations = Array.isArray(node.annotations) ? [...node.annotations] : [];

    if (Array.isArray(item.annotations)) {
      if (item.replace === true) {
        annotations = item.annotations.map((entry) => normalizeAnnotation(entry));
      } else {
        annotations = annotations.concat(item.annotations.map((entry) => normalizeAnnotation(entry)));
      }
    } else {
      const annotation = normalizeAnnotation(item.annotation || item);
      if (item.replace === true) {
        annotations = [annotation];
      } else if (typeof item.index === "number" && item.index >= 0) {
        annotations[item.index] = annotation;
      } else {
        annotations.push(annotation);
      }
    }

    node.annotations = annotations;
    return { nodeId: node.id, annotations: node.annotations };
  });

  return { updated: results.length, results };
}

function scanNodesByTypes(params) {
  const nextParams = {
    types: Array.isArray(params.types) ? params.types : undefined,
    type: typeof params.type === "string" ? params.type : undefined,
    limit: params.limit,
    pageId: params.pageId,
    parentId: params.parentId
  };
  return searchNodes(nextParams);
}

function getDocumentInfo() {
  const pages = figma.root.children.map((page) => ({ id: page.id, name: page.name }));
  return {
    id: figma.root.id,
    name: figma.root.name,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pageCount: pages.length,
    pages
  };
}

function getSelection(params) {
  const depth = typeof params.depth === "number" ? params.depth : 1;
  const selection = figma.currentPage.selection || [];
  return {
    pageId: figma.currentPage.id,
    selection: selection.map((node) => nodeToJSON(node, depth))
  };
}

function readMyDesign() {
  return getSelection({ depth: 2 });
}

function getNodeInfo(params) {
  return getNode(params);
}

function getNodesInfo(params) {
  const depth = typeof params.depth === "number" ? params.depth : 1;
  if (!Array.isArray(params.nodeIds)) {
    throw new Error("nodeIds must be an array");
  }
  if (params.nodeIds.length === 0) {
    return { nodes: [] };
  }
  const nodes = params.nodeIds.map((nodeId) => getNodeById(nodeId));
  return {
    nodes: nodes.map((node) => nodeToJSON(node, depth))
  };
}

function snapshotNodes(params) {
  const depth = typeof params.depth === "number" ? params.depth : 0;
  if (!Array.isArray(params.nodeIds)) {
    throw new Error("nodeIds must be an array");
  }
  const nodes = params.nodeIds.map((nodeId) => getNodeById(nodeId));
  return {
    timestamp: Date.now(),
    nodes: nodes.map((node) => nodeToJSON(node, depth))
  };
}

function setFocus(params) {
  const node = getSceneNode(params.nodeId);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  return { nodeId: node.id };
}

function setSelections(params) {
  if (!Array.isArray(params.nodeIds)) {
    throw new Error("nodeIds must be an array");
  }
  if (params.nodeIds.length === 0) {
    figma.currentPage.selection = [];
    return { count: 0, nodeIds: [] };
  }
  const nodes = params.nodeIds.map((nodeId) => getSceneNode(nodeId));
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  return { count: nodes.length, nodeIds: nodes.map((node) => node.id) };
}

function getNode(params) {
  const depth = typeof params.depth === "number" ? params.depth : 1;
  const node = getNodeById(params.nodeId);
  return nodeToJSON(node, depth);
}

function getPageTree(params) {
  const depth = typeof params.depth === "number" ? params.depth : 2;
  let page = figma.currentPage;
  if (typeof params.pageId === "string") {
    const node = getNodeById(params.pageId);
    if (node.type !== "PAGE") throw new Error("pageId must be a PAGE node");
    page = node;
  }
  return nodeToJSON(page, depth);
}

function searchNodes(params) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 100;
  const nameContains =
    typeof params.nameContains === "string" && params.nameContains.trim().length > 0
      ? params.nameContains.trim().toLowerCase()
      : null;

  const allowedTypes = new Set();
  if (typeof params.type === "string") allowedTypes.add(params.type);
  if (Array.isArray(params.types)) {
    params.types.forEach((value) => {
      if (typeof value === "string") allowedTypes.add(value);
    });
  }

  let root = figma.currentPage;
  if (typeof params.parentId === "string") {
    root = getNodeById(params.parentId);
  } else if (typeof params.pageId === "string") {
    root = getNodeById(params.pageId);
  }

  if (!("findAll" in root)) {
    throw new Error("Root node does not support findAll");
  }

  const results = root.findAll((node) => {
    if (allowedTypes.size > 0 && !allowedTypes.has(node.type)) return false;
    if (nameContains && !node.name.toLowerCase().includes(nameContains)) return false;
    return true;
  });

  const sliced = results.slice(0, limit);
  return {
    rootId: root.id,
    count: results.length,
    returned: sliced.length,
    results: sliced.map((node) => nodeToJSON(node, 0))
  };
}

function queryNodes(params) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 100;
  const nameContains =
    typeof params.nameContains === "string" && params.nameContains.trim().length > 0
      ? params.nameContains.trim().toLowerCase()
      : null;

  let nameRegex = null;
  if (typeof params.nameRegex === "string" && params.nameRegex.length > 0) {
    try {
      const flags = typeof params.nameRegexFlags === "string" ? params.nameRegexFlags : "i";
      nameRegex = new RegExp(params.nameRegex, flags);
    } catch (err) {
      throw new Error("Invalid nameRegex");
    }
  }

  const allowedTypes = new Set();
  if (typeof params.type === "string") allowedTypes.add(params.type);
  if (Array.isArray(params.types)) {
    params.types.forEach((value) => {
      if (typeof value === "string") allowedTypes.add(value);
    });
  }

  const visible = typeof params.visible === "boolean" ? params.visible : null;
  const locked = typeof params.locked === "boolean" ? params.locked : null;
  const opacityMin = typeof params.opacityMin === "number" ? params.opacityMin : null;
  const opacityMax = typeof params.opacityMax === "number" ? params.opacityMax : null;
  const hasFills = typeof params.hasFills === "boolean" ? params.hasFills : null;
  const hasStrokes = typeof params.hasStrokes === "boolean" ? params.hasStrokes : null;
  const textContains =
    typeof params.textContains === "string" && params.textContains.trim().length > 0
      ? params.textContains.trim().toLowerCase()
      : null;

  let root = figma.currentPage;
  if (typeof params.parentId === "string") {
    root = getNodeById(params.parentId);
  } else if (typeof params.pageId === "string") {
    root = getNodeById(params.pageId);
  }

  if (!("findAll" in root)) {
    throw new Error("Root node does not support findAll");
  }

  const results = root.findAll((node) => {
    if (allowedTypes.size > 0 && !allowedTypes.has(node.type)) return false;
    if (nameContains && !node.name.toLowerCase().includes(nameContains)) return false;
    if (nameRegex && !nameRegex.test(node.name)) return false;

    if (visible !== null) {
      if (!("visible" in node) || node.visible !== visible) return false;
    }
    if (locked !== null) {
      if (!("locked" in node) || node.locked !== locked) return false;
    }
    if (opacityMin !== null || opacityMax !== null) {
      if (!("opacity" in node)) return false;
      if (opacityMin !== null && node.opacity < opacityMin) return false;
      if (opacityMax !== null && node.opacity > opacityMax) return false;
    }
    if (hasFills !== null) {
      if (!("fills" in node)) return false;
      const fills = node.fills === MIXED ? [] : node.fills;
      const has = Array.isArray(fills) && fills.length > 0;
      if (hasFills !== has) return false;
    }
    if (hasStrokes !== null) {
      if (!("strokes" in node)) return false;
      const strokes = node.strokes === MIXED ? [] : node.strokes;
      const has = Array.isArray(strokes) && strokes.length > 0;
      if (hasStrokes !== has) return false;
    }
    if (textContains) {
      if (node.type !== "TEXT") return false;
      if (!node.characters.toLowerCase().includes(textContains)) return false;
    }

    return true;
  });

  const sliced = results.slice(0, limit);
  return {
    rootId: root.id,
    count: results.length,
    returned: sliced.length,
    results: sliced.map((node) => nodeToJSON(node, 0))
  };
}

async function exportPng(params) {
  const node = getSceneNode(params.nodeId);
  const scale = typeof params.scale === "number" && params.scale > 0 ? params.scale : 1;
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale }
  });
  const base64 = figma.base64Encode(bytes);
  return {
    nodeId: node.id,
    scale,
    bytes: bytes.length,
    dataUrl: `data:image/png;base64,${base64}`
  };
}

async function exportSvg(params) {
  const node = getSceneNode(params.nodeId);
  const bytes = await node.exportAsync({ format: "SVG" });
  const base64 = figma.base64Encode(bytes);
  const svgText = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(bytes) : null;
  return {
    nodeId: node.id,
    bytes: bytes.length,
    dataUrl: `data:image/svg+xml;base64,${base64}`,
    svg: svgText
  };
}

async function exportPdf(params) {
  const node = getSceneNode(params.nodeId);
  const bytes = await node.exportAsync({ format: "PDF" });
  const base64 = figma.base64Encode(bytes);
  return {
    nodeId: node.id,
    bytes: bytes.length,
    dataUrl: `data:application/pdf;base64,${base64}`
  };
}

function parseColor(color) {
  if (!color || typeof color !== "object") return null;
  const r = typeof color.r === "number" ? color.r : 0;
  const g = typeof color.g === "number" ? color.g : 0;
  const b = typeof color.b === "number" ? color.b : 0;
  const a = typeof color.a === "number" ? color.a : 1;
  return { r, g, b, a };
}

function setSolidFill(node, color) {
  const parsed = parseColor(color);
  if (!parsed || !("fills" in node)) return;
  node.fills = [
    {
      type: "SOLID",
      color: { r: parsed.r, g: parsed.g, b: parsed.b },
      opacity: parsed.a
    }
  ];
}

function setSolidStroke(node, color, strokeWeight) {
  const parsed = parseColor(color);
  if (!parsed || !("strokes" in node)) return;
  node.strokes = [
    {
      type: "SOLID",
      color: { r: parsed.r, g: parsed.g, b: parsed.b },
      opacity: parsed.a
    }
  ];
  if (typeof strokeWeight === "number" && "strokeWeight" in node) {
    node.strokeWeight = strokeWeight;
  }
}

function createShape(params) {
  const shape = params.shape === "ellipse" ? "ellipse" : "rectangle";
  const width = typeof params.width === "number" && params.width > 0 ? params.width : 100;
  const height = typeof params.height === "number" && params.height > 0 ? params.height : 100;

  const node = shape === "ellipse" ? figma.createEllipse() : figma.createRectangle();
  node.resize(width, height);

  if (typeof params.x === "number") node.x = params.x;
  if (typeof params.y === "number") node.y = params.y;

  if (params.fillColor) setSolidFill(node, params.fillColor);
  if (params.strokeColor) setSolidStroke(node, params.strokeColor, params.strokeWeight);

  const parentId = params.parentId;
  let parent = figma.currentPage;
  if (typeof parentId === "string") {
    const candidate = figma.getNodeById(parentId);
    if (candidate && "appendChild" in candidate) parent = candidate;
  }
  parent.appendChild(node);

  return nodeToJSON(node, 1);
}

function resolveParentNode(parentId) {
  if (typeof parentId !== "string") return figma.currentPage;
  const node = figma.getNodeById(parentId);
  if (node && "appendChild" in node) return node;
  return figma.currentPage;
}

function createRectangle(params) {
  const width = typeof params.width === "number" && params.width > 0 ? params.width : 100;
  const height = typeof params.height === "number" && params.height > 0 ? params.height : 100;
  const node = figma.createRectangle();
  node.resize(width, height);
  if (typeof params.x === "number") node.x = params.x;
  if (typeof params.y === "number") node.y = params.y;
  if (typeof params.name === "string") node.name = params.name;

  if (params.fillColor) setSolidFill(node, params.fillColor);
  if (params.strokeColor) setSolidStroke(node, params.strokeColor, params.strokeWeight);

  resolveParentNode(params.parentId).appendChild(node);
  return nodeToJSON(node, 1);
}

function createFrame(params) {
  const width = typeof params.width === "number" && params.width > 0 ? params.width : 320;
  const height = typeof params.height === "number" && params.height > 0 ? params.height : 240;
  const node = figma.createFrame();
  node.resize(width, height);
  if (typeof params.x === "number") node.x = params.x;
  if (typeof params.y === "number") node.y = params.y;
  if (typeof params.name === "string") node.name = params.name;

  if (params.fillColor) setSolidFill(node, params.fillColor);
  if (params.strokeColor) setSolidStroke(node, params.strokeColor, params.strokeWeight);

  resolveParentNode(params.parentId).appendChild(node);
  return nodeToJSON(node, 1);
}

async function createText(params) {
  const node = figma.createText();
  if (typeof params.x === "number") node.x = params.x;
  if (typeof params.y === "number") node.y = params.y;
  if (typeof params.name === "string") node.name = params.name;

  let fontName = params.fontName;
  if (!fontName) {
    fontName = { family: "Inter", style: "Regular" };
  }
  await figma.loadFontAsync(fontName);
  node.fontName = fontName;

  if (typeof params.fontSize === "number") {
    node.fontSize = params.fontSize;
  }

  const content = typeof params.characters === "string" ? params.characters : "";
  node.characters = content;

  resolveParentNode(params.parentId).appendChild(node);
  return nodeToJSON(node, 1);
}

function scanTextNodes(params) {
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 200;
  const chunkSize = typeof params.chunkSize === "number" && params.chunkSize > 0 ? params.chunkSize : 50;
  const offset = typeof params.offset === "number" && params.offset >= 0 ? params.offset : 0;
  const includeText = params.includeText === true;

  let root = figma.currentPage;
  if (typeof params.parentId === "string") {
    root = getNodeById(params.parentId);
  } else if (typeof params.pageId === "string") {
    root = getNodeById(params.pageId);
  }

  if (!("findAll" in root)) {
    throw new Error("Root node does not support findAll");
  }

  const all = root.findAll((node) => node.type === "TEXT");
  const slice = all.slice(offset, offset + Math.min(chunkSize, limit));

  const results = slice.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    characters: includeText ? node.characters : undefined
  }));

  return {
    total: all.length,
    offset,
    returned: results.length,
    nextOffset: offset + results.length < all.length ? offset + results.length : null,
    nodes: results
  };
}

async function setTextContent(params) {
  const node = getSceneNode(params.nodeId);
  if (node.type !== "TEXT") throw new Error("Node is not a TEXT node");

  let fontName = params.fontName;
  if (!fontName) {
    if (node.fontName === MIXED) {
      throw new Error("Text node has mixed fonts. Provide fontName.");
    }
    fontName = node.fontName;
  }

  await figma.loadFontAsync(fontName);
  node.fontName = fontName;

  if (typeof params.fontSize === "number") {
    node.fontSize = params.fontSize;
  }

  node.characters = typeof params.text === "string" ? params.text : "";
  return nodeToJSON(node, 0);
}

async function setMultipleTextContents(params) {
  if (!Array.isArray(params.items)) {
    throw new Error("items must be an array");
  }

  const results = [];
  for (const item of params.items) {
    const node = getSceneNode(item.nodeId);
    if (node.type !== "TEXT") {
      results.push({ nodeId: item.nodeId, error: "Node is not a TEXT node" });
      continue;
    }

    let fontName = item.fontName;
    if (!fontName) {
      if (node.fontName === MIXED) {
        results.push({ nodeId: item.nodeId, error: "Mixed fonts. Provide fontName." });
        continue;
      }
      fontName = node.fontName;
    }

    await figma.loadFontAsync(fontName);
    node.fontName = fontName;

    if (typeof item.fontSize === "number") {
      node.fontSize = item.fontSize;
    }

    node.characters = typeof item.text === "string" ? item.text : "";
    results.push({ nodeId: node.id, ok: true });
  }

  return { updated: results.length, results };
}

function getAutoLayoutFrame(params) {
  const node = getSceneNode(params.nodeId);
  if (!("layoutMode" in node)) {
    throw new Error("Node does not support auto layout");
  }
  return node;
}

function setLayoutMode(params) {
  const node = getAutoLayoutFrame(params);
  const mode = params.layoutMode;
  if (mode !== "NONE" && mode !== "HORIZONTAL" && mode !== "VERTICAL") {
    throw new Error("layoutMode must be NONE, HORIZONTAL, or VERTICAL");
  }
  node.layoutMode = mode;

  if (typeof params.primaryAxisAlignItems === "string") {
    node.primaryAxisAlignItems = params.primaryAxisAlignItems;
  }
  if (typeof params.counterAxisAlignItems === "string") {
    node.counterAxisAlignItems = params.counterAxisAlignItems;
  }
  if (typeof params.primaryAxisSizingMode === "string") {
    node.primaryAxisSizingMode = params.primaryAxisSizingMode;
  }
  if (typeof params.counterAxisSizingMode === "string") {
    node.counterAxisSizingMode = params.counterAxisSizingMode;
  }
  if (typeof params.itemSpacing === "number") {
    node.itemSpacing = params.itemSpacing;
  }
  if (typeof params.paddingTop === "number") node.paddingTop = params.paddingTop;
  if (typeof params.paddingRight === "number") node.paddingRight = params.paddingRight;
  if (typeof params.paddingBottom === "number") node.paddingBottom = params.paddingBottom;
  if (typeof params.paddingLeft === "number") node.paddingLeft = params.paddingLeft;

  if (typeof params.layoutWrap === "string" && "layoutWrap" in node) {
    node.layoutWrap = params.layoutWrap;
  }

  return nodeToJSON(node, 0);
}

function setPadding(params) {
  const node = getAutoLayoutFrame(params);
  if (typeof params.top === "number") node.paddingTop = params.top;
  if (typeof params.right === "number") node.paddingRight = params.right;
  if (typeof params.bottom === "number") node.paddingBottom = params.bottom;
  if (typeof params.left === "number") node.paddingLeft = params.left;
  return nodeToJSON(node, 0);
}

function setAxisAlign(params) {
  const node = getAutoLayoutFrame(params);
  if (typeof params.primaryAxisAlignItems === "string") {
    node.primaryAxisAlignItems = params.primaryAxisAlignItems;
  }
  if (typeof params.counterAxisAlignItems === "string") {
    node.counterAxisAlignItems = params.counterAxisAlignItems;
  }
  return nodeToJSON(node, 0);
}

function setLayoutSizing(params) {
  const node = getSceneNode(params.nodeId);
  const canSize =
    "layoutSizingHorizontal" in node ||
    "layoutSizingVertical" in node ||
    "primaryAxisSizingMode" in node ||
    "counterAxisSizingMode" in node;
  if (!canSize) {
    throw new Error("Node does not support layout sizing");
  }
  const horizontal = params.horizontal || params.layoutSizingHorizontal;
  const vertical = params.vertical || params.layoutSizingVertical;

  const validSizing = new Set(["HUG", "FILL", "FIXED"]);
  if (horizontal && !validSizing.has(horizontal)) {
    throw new Error("horizontal must be HUG, FILL, or FIXED");
  }
  if (vertical && !validSizing.has(vertical)) {
    throw new Error("vertical must be HUG, FILL, or FIXED");
  }

  if (horizontal && "layoutSizingHorizontal" in node) {
    node.layoutSizingHorizontal = horizontal;
  }
  if (vertical && "layoutSizingVertical" in node) {
    node.layoutSizingVertical = vertical;
  }

  if (typeof params.primaryAxisSizingMode === "string") {
    node.primaryAxisSizingMode = params.primaryAxisSizingMode;
  }
  if (typeof params.counterAxisSizingMode === "string") {
    node.counterAxisSizingMode = params.counterAxisSizingMode;
  }

  if ((horizontal || vertical) && !("layoutSizingHorizontal" in node)) {
    if (horizontal === "FILL" || vertical === "FILL") {
      throw new Error("FILL sizing is only supported on auto-layout children");
    }
    // Map HUG -> AUTO, FIXED -> FIXED for auto layout frames without layoutSizing* props
    if (horizontal === "HUG") {
      node.primaryAxisSizingMode = "AUTO";
    } else if (horizontal === "FIXED") {
      node.primaryAxisSizingMode = "FIXED";
    }
    if (vertical === "HUG") {
      node.counterAxisSizingMode = "AUTO";
    } else if (vertical === "FIXED") {
      node.counterAxisSizingMode = "FIXED";
    }
  }
  return nodeToJSON(node, 0);
}

function setItemSpacing(params) {
  const node = getAutoLayoutFrame(params);
  if (typeof params.itemSpacing !== "number") {
    throw new Error("itemSpacing must be a number");
  }
  node.itemSpacing = params.itemSpacing;
  return nodeToJSON(node, 0);
}

function moveNode(params) {
  const node = getSceneNode(params.nodeId);
  if (typeof params.x === "number") node.x = params.x;
  if (typeof params.y === "number") node.y = params.y;
  return nodeToJSON(node, 0);
}

function resizeNode(params) {
  const node = getSceneNode(params.nodeId);
  if (typeof node.resize !== "function") {
    throw new Error("Node cannot be resized");
  }
  if (typeof params.width !== "number" || typeof params.height !== "number") {
    throw new Error("width and height are required");
  }
  node.resize(params.width, params.height);
  return nodeToJSON(node, 0);
}

function deleteNode(params) {
  const node = getSceneNode(params.nodeId);
  node.remove();
  return { nodeId: params.nodeId, deleted: true };
}

function deleteMultipleNodes(params) {
  if (!Array.isArray(params.nodeIds)) {
    throw new Error("nodeIds must be an array");
  }
  const deleted = [];
  for (const nodeId of params.nodeIds) {
    const node = getSceneNode(nodeId);
    node.remove();
    deleted.push(nodeId);
  }
  return { deletedCount: deleted.length, nodeIds: deleted };
}

function cloneNode(params) {
  const node = getSceneNode(params.nodeId);
  const clone = node.clone();
  if (typeof params.x === "number") {
    clone.x = params.x;
  } else if (typeof params.dx === "number") {
    clone.x = clone.x + params.dx;
  }
  if (typeof params.y === "number") {
    clone.y = params.y;
  } else if (typeof params.dy === "number") {
    clone.y = clone.y + params.dy;
  }
  if (typeof params.name === "string") clone.name = params.name;
  if (params.appendToParent === true && node.parent && "appendChild" in node.parent) {
    node.parent.appendChild(clone);
  }
  return nodeToJSON(clone, 0);
}

function getStyles(params) {
  return getStylesAsync(params);
}

async function getStylesAsync(params) {
  const includeRemote = params && params.includeRemote === true;
  const styles = figma.getLocalPaintStyles()
    .map((style) => ({
      id: style.id,
      name: style.name,
      type: style.type,
      paints: style.paints
    }))
    .concat(
      figma.getLocalTextStyles().map((style) => ({
        id: style.id,
        name: style.name,
        type: style.type,
        fontName: style.fontName,
        fontSize: style.fontSize,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight
      }))
    )
    .concat(
      figma.getLocalEffectStyles().map((style) => ({
        id: style.id,
        name: style.name,
        type: style.type,
        effects: style.effects
      }))
    )
    .concat(
      figma.getLocalGridStyles().map((style) => ({
        id: style.id,
        name: style.name,
        type: style.type,
        layoutGrids: style.layoutGrids
      }))
    );

  if (includeRemote && figma.getTeamLibrary && figma.getTeamLibraryStylesAsync) {
    return await getTeamLibraryStyles(styles);
  }

  return { local: styles };
}

async function getTeamLibraryStyles(localStyles) {
  const libraryStyles = await figma.getTeamLibraryStylesAsync();
  return { local: localStyles, remote: libraryStyles };
}

function getLocalComponents(params) {
  return getLocalComponentsAsync(params);
}

async function getLocalComponentsAsync(params) {
  const includeAllPages = params && params.includeAllPages === true;
  if (includeAllPages) {
    await figma.loadAllPagesAsync();
  }
  const root = includeAllPages ? figma.root : figma.currentPage;
  const components = root.findAll((node) => node.type === "COMPONENT" || node.type === "COMPONENT_SET");
  const result = components.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type
  }));
  return { count: result.length, components: result };
}

function createComponentInstance(params) {
  const component = getSceneNode(params.componentId);
  if (component.type !== "COMPONENT" && component.type !== "COMPONENT_SET") {
    throw new Error("componentId must reference a COMPONENT or COMPONENT_SET");
  }

  let instance = null;
  if (component.type === "COMPONENT_SET") {
    const variantId = params.variantId;
    if (typeof variantId === "string") {
      const variant = component.children.find((child) => child.id === variantId);
      if (variant && variant.type === "COMPONENT") {
        instance = variant.createInstance();
      }
    }
    if (!instance) {
      instance = component.defaultVariant.createInstance();
    }
  } else {
    instance = component.createInstance();
  }

  if (typeof params.x === "number") instance.x = params.x;
  if (typeof params.y === "number") instance.y = params.y;
  if (typeof params.name === "string") instance.name = params.name;

  resolveParentNode(params.parentId).appendChild(instance);
  return nodeToJSON(instance, 1);
}

function getInstanceOverrides(params) {
  const node = getSceneNode(params.nodeId);
  if (node.type !== "INSTANCE") throw new Error("Node is not an INSTANCE");
  const overrides = node.getProperties();
  return { nodeId: node.id, overrides };
}

function setInstanceOverrides(params) {
  const node = getSceneNode(params.nodeId);
  if (node.type !== "INSTANCE") throw new Error("Node is not an INSTANCE");
  if (!params.overrides || typeof params.overrides !== "object") {
    throw new Error("overrides must be an object");
  }
  node.setProperties(params.overrides);
  return { nodeId: node.id, ok: true };
}

function setFillColor(params) {
  const node = getSceneNode(params.nodeId);
  if (!("fills" in node)) throw new Error("Node does not support fills");
  setSolidFill(node, params.color || params.fillColor || params);
  return nodeToJSON(node, 0);
}

function setStrokeColor(params) {
  const node = getSceneNode(params.nodeId);
  if (!("strokes" in node)) throw new Error("Node does not support strokes");
  const color = params.color || params.strokeColor || params;
  setSolidStroke(node, color, params.strokeWeight);
  return nodeToJSON(node, 0);
}

function setCornerRadius(params) {
  const node = getSceneNode(params.nodeId);
  const corners = params.corners;
  if (corners && typeof corners === "object") {
    if ("topLeft" in node && typeof corners.topLeft === "number") node.topLeftRadius = corners.topLeft;
    if ("topRight" in node && typeof corners.topRight === "number") node.topRightRadius = corners.topRight;
    if ("bottomLeft" in node && typeof corners.bottomLeft === "number") node.bottomLeftRadius = corners.bottomLeft;
    if ("bottomRight" in node && typeof corners.bottomRight === "number") node.bottomRightRadius = corners.bottomRight;
    return nodeToJSON(node, 0);
  }
  if ("cornerRadius" in node && typeof params.cornerRadius === "number") {
    node.cornerRadius = params.cornerRadius;
    return nodeToJSON(node, 0);
  }
  throw new Error("Node does not support corner radius or missing radius values");
}

function getReactions(params) {
  return getReactionsAsync(params);
}

async function getReactionsAsync(params) {
  const includeAllPages = params && params.includeAllPages === true;
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : null;
  const highlightOnly = params && params.highlightOnly === true;

  if (params && typeof params.nodeId === "string") {
    const node = getSceneNode(params.nodeId);
    const reactions = Array.isArray(node.reactions)
      ? node.reactions.filter((reaction) => !highlightOnly || isHighlightReaction(reaction))
      : [];
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      reactions
    };
  }

  let pages = [];
  if (params && typeof params.pageId === "string") {
    const page = getNodeById(params.pageId);
    if (page.type !== "PAGE") throw new Error("pageId must be a PAGE node");
    pages = [page];
  } else if (includeAllPages) {
    await figma.loadAllPagesAsync();
    pages = figma.root.children;
  } else {
    pages = [figma.currentPage];
  }

  const nodes = [];
  for (const page of pages) {
    if (!("findAll" in page)) continue;
    const found = page.findAll((node) => {
      if (!Array.isArray(node.reactions) || node.reactions.length === 0) return false;
      if (!highlightOnly) return true;
      return node.reactions.some((reaction) => isHighlightReaction(reaction));
    });
    for (const node of found) {
      const reactions = highlightOnly
        ? node.reactions.filter((reaction) => isHighlightReaction(reaction))
        : node.reactions;
      nodes.push({
        nodeId: node.id,
        pageId: page.id,
        name: node.name,
        type: node.type,
        reactions
      });
      if (limit && nodes.length >= limit) break;
    }
    if (limit && nodes.length >= limit) break;
  }

  return {
    pageCount: pages.length,
    nodeCount: nodes.length,
    highlightOnly,
    nodes
  };
}

function isHighlightReaction(reaction) {
  if (!reaction || !reaction.action) return false;
  const action = reaction.action;
  if (action.type !== "NODE") return false;
  if (action.navigation === "NONE") return true;
  if (action.transition && action.transition.type === "SMART_ANIMATE") return true;
  return false;
}

function ensureFigJamConnectors() {
  if (figma.editorType && figma.editorType !== "figjam") {
    throw new Error("Connectors are only available in FigJam");
  }
  if (typeof figma.createConnector !== "function") {
    throw new Error("createConnector is not available in this editor");
  }
}

function extractConnectorStyle(connector) {
  const style = {};
  if ("connectorLineType" in connector) style.connectorLineType = connector.connectorLineType;
  if ("connectorStartStrokeCap" in connector) style.connectorStartStrokeCap = connector.connectorStartStrokeCap;
  if ("connectorEndStrokeCap" in connector) style.connectorEndStrokeCap = connector.connectorEndStrokeCap;
  if ("strokes" in connector) style.strokes = connector.strokes;
  if ("strokeWeight" in connector) style.strokeWeight = connector.strokeWeight;
  if ("dashPattern" in connector) style.dashPattern = connector.dashPattern;
  if ("opacity" in connector) style.opacity = connector.opacity;
  return style;
}

function applyConnectorStyle(connector, style) {
  if (!style) return;
  if ("connectorLineType" in style && "connectorLineType" in connector) {
    connector.connectorLineType = style.connectorLineType;
  }
  if ("connectorStartStrokeCap" in style && "connectorStartStrokeCap" in connector) {
    connector.connectorStartStrokeCap = style.connectorStartStrokeCap;
  }
  if ("connectorEndStrokeCap" in style && "connectorEndStrokeCap" in connector) {
    connector.connectorEndStrokeCap = style.connectorEndStrokeCap;
  }
  if ("strokes" in style && "strokes" in connector) {
    connector.strokes = style.strokes;
  }
  if ("strokeWeight" in style && "strokeWeight" in connector) {
    connector.strokeWeight = style.strokeWeight;
  }
  if ("dashPattern" in style && "dashPattern" in connector) {
    connector.dashPattern = style.dashPattern;
  }
  if ("opacity" in style && "opacity" in connector) {
    connector.opacity = style.opacity;
  }
}

function getConnectorNodeFromSelection(params) {
  if (params && typeof params.connectorId === "string") {
    const node = getSceneNode(params.connectorId);
    if (node.type !== "CONNECTOR") throw new Error("connectorId must be a CONNECTOR node");
    return node;
  }

  const selection = figma.currentPage.selection || [];
  const connector = selection.find((node) => node.type === "CONNECTOR");
  if (!connector) {
    throw new Error("No connector selected. Select a connector or pass connectorId.");
  }
  return connector;
}

function setDefaultConnector(params) {
  ensureFigJamConnectors();
  const connector = getConnectorNodeFromSelection(params || {});
  defaultConnectorStyle = extractConnectorStyle(connector);
  return { ok: true, style: defaultConnectorStyle };
}

function createConnections(params) {
  ensureFigJamConnectors();
  if (!Array.isArray(params.connections)) {
    throw new Error("connections must be an array");
  }

  const created = [];
  for (const item of params.connections) {
    const fromNode = getSceneNode(item.fromNodeId);
    const toNode = getSceneNode(item.toNodeId);

    const connector = figma.createConnector();
    const start = { endpointNodeId: fromNode.id };
    if (typeof item.fromMagnet === "string") start.magnet = item.fromMagnet;
    const end = { endpointNodeId: toNode.id };
    if (typeof item.toMagnet === "string") end.magnet = item.toMagnet;
    connector.connectorStart = start;
    connector.connectorEnd = end;

    applyConnectorStyle(connector, defaultConnectorStyle);
    applyConnectorStyle(connector, item.style);

    if (typeof item.connectorLineType === "string") connector.connectorLineType = item.connectorLineType;
    if (typeof item.connectorStartStrokeCap === "string") connector.connectorStartStrokeCap = item.connectorStartStrokeCap;
    if (typeof item.connectorEndStrokeCap === "string") connector.connectorEndStrokeCap = item.connectorEndStrokeCap;
    if (item.strokes) connector.strokes = item.strokes;
    if (typeof item.strokeWeight === "number") connector.strokeWeight = item.strokeWeight;
    if (item.dashPattern) connector.dashPattern = item.dashPattern;
    if (typeof item.opacity === "number") connector.opacity = item.opacity;

    if (typeof item.name === "string") connector.name = item.name;

    if (typeof item.parentId === "string") {
      const parent = getNodeById(item.parentId);
      if (parent && "appendChild" in parent) parent.appendChild(connector);
    }

    created.push({ connectorId: connector.id, fromNodeId: fromNode.id, toNodeId: toNode.id });
  }

  return { createdCount: created.length, connectors: created };
}

async function exportNodeAsImage(params) {
  const node = getSceneNode(params.nodeId);
  const formatInput = typeof params.format === "string" ? params.format.toUpperCase() : "PNG";
  const format = formatInput === "JPEG" ? "JPG" : formatInput;
  if (!["PNG", "JPG", "SVG", "PDF"].includes(format)) {
    throw new Error("format must be PNG, JPG, SVG, or PDF");
  }

  const settings = { format };

  if ((format === "PNG" || format === "JPG") && typeof params.scale === "number" && params.scale > 0) {
    settings.constraint = { type: "SCALE", value: params.scale };
  }
  if (format === "JPG" && typeof params.quality === "number") {
    const q = Math.max(0, Math.min(1, params.quality));
    settings.quality = q;
  }
  if (format === "SVG" && typeof params.svgOutlineText === "boolean") {
    settings.svgOutlineText = params.svgOutlineText;
  }

  const bytes = await node.exportAsync(settings);
  const base64 = figma.base64Encode(bytes);

  let mime = "application/octet-stream";
  if (format === "PNG") mime = "image/png";
  if (format === "JPG") mime = "image/jpeg";
  if (format === "SVG") mime = "image/svg+xml";
  if (format === "PDF") mime = "application/pdf";

  const result = {
    nodeId: node.id,
    format,
    bytes: bytes.length,
    mime,
    dataUrl: `data:${mime};base64,${base64}`
  };

  if (format === "SVG") {
    result.svg = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(bytes) : null;
  }

  return result;
}

async function setText(params) {
  const node = getSceneNode(params.nodeId);
  if (node.type !== "TEXT") throw new Error("Node is not a TEXT node");

  let fontName = params.fontName;
  if (!fontName) {
    if (node.fontName === MIXED) {
      throw new Error("Text node has mixed fonts. Provide fontName.");
    }
    fontName = node.fontName;
  }

  await figma.loadFontAsync(fontName);
  node.fontName = fontName;

  if (typeof params.fontSize === "number") {
    node.fontSize = params.fontSize;
  }

  node.characters = typeof params.characters === "string" ? params.characters : "";
  return nodeToJSON(node, 0);
}

function updateStyle(params) {
  const node = getSceneNode(params.nodeId);

  if (typeof params.name === "string") node.name = params.name;
  if (typeof params.visible === "boolean" && "visible" in node) node.visible = params.visible;
  if (typeof params.locked === "boolean" && "locked" in node) node.locked = params.locked;
  if (typeof params.opacity === "number" && "opacity" in node) node.opacity = params.opacity;

  if ("fills" in node && params.fills !== undefined) node.fills = params.fills;
  if ("strokes" in node && params.strokes !== undefined) node.strokes = params.strokes;
  if ("strokeWeight" in node && params.strokeWeight !== undefined) node.strokeWeight = params.strokeWeight;
  if ("cornerRadius" in node && params.cornerRadius !== undefined) node.cornerRadius = params.cornerRadius;

  return nodeToJSON(node, 0);
}

figma.on("selectionchange", () => {
  const selection = figma.currentPage.selection || [];
  emitEvent("selectionchange", {
    pageId: figma.currentPage.id,
    selectionIds: selection.map((node) => node.id),
    selection: selection.map((node) => nodeToJSON(node, 0))
  });
});

figma.on("currentpagechange", () => {
  emitEvent("currentpagechange", {
    pageId: figma.currentPage.id,
    name: figma.currentPage.name
  });
});

figma.on("documentchange", (event) => {
  emitEvent("documentchange", {
    pageId: figma.currentPage.id,
    changes: summarizeDocChanges(event.documentChanges || [])
  });
});
