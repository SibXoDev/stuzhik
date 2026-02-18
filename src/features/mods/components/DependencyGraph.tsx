import { createSignal, createEffect, createMemo, onMount, onCleanup, Show, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../shared/i18n";
import { registerSearchHandler, unregisterSearchHandler } from "../../../shared/stores";
import type { DependencyGraphData, DependencyEdge, GraphNode, ModRemovalAnalysis } from "./graphTypes";
import { VERTEX_SHADER_CIRCLE, FRAGMENT_SHADER_CIRCLE, VERTEX_SHADER_LINE, FRAGMENT_SHADER_LINE } from "./graphShaders";
import { createGraphNodes, runForceSimulation, createLivePhysics } from "./graphPhysics";
import type { LivePhysicsController } from "./graphPhysics";
import GraphNodePanel from "./GraphNodePanel";
import RemovalAnalysisDialog from "./RemovalAnalysisDialog";
import { Tooltip } from "../../../shared/ui";

interface Props {
  instanceId: string;
  onClose?: () => void;
}

export default function DependencyGraph(props: Props) {
  const { t } = useI18n();

  // State
  const [graph, setGraph] = createSignal<DependencyGraphData | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [nodes, setNodes] = createSignal<GraphNode[]>([]);
  const [selectedNode, setSelectedNode] = createSignal<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = createSignal<GraphNode | null>(null);
  const [removalAnalysis, setRemovalAnalysis] = createSignal<ModRemovalAnalysis | null>(null);
  const [showRemovalDialog, setShowRemovalDialog] = createSignal(false);
  const [simulationProgress, setSimulationProgress] = createSignal(0);
  const [canvasReady, setCanvasReady] = createSignal(false);

  // View state
  const [zoom, setZoom] = createSignal(1);
  const [panX, setPanX] = createSignal(0);
  const [panY, setPanY] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);
  const [draggedNode, setDraggedNode] = createSignal<GraphNode | null>(null);
  const [isPanning, setIsPanning] = createSignal(false);
  const [lastMousePos, setLastMousePos] = createSignal({ x: 0, y: 0 });
  const [wasDragged, setWasDragged] = createSignal(false); // Track if drag actually happened

  // Filters
  const [showLibraries, setShowLibraries] = createSignal(true);
  const [showDisabled, setShowDisabled] = createSignal(false);
  const [highlightProblems, setHighlightProblems] = createSignal(true);
  const [showOrphans, setShowOrphans] = createSignal(false); // Hide mods without dependencies by default

  // Live physics simulation
  const [livePhysics, setLivePhysics] = createSignal(true); // Always on by default

  // Search state
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResults, setSearchResults] = createSignal<GraphNode[]>([]);
  const [searchIndex, setSearchIndex] = createSignal(0);
  let searchInputRef: HTMLInputElement | undefined;

  // Helper: find node by id with fallback matching (defined once, reused)
  const findNodeByIdOrName = (allNodes: GraphNode[], id: string, name?: string): GraphNode | undefined => {
    // 1. Exact match on id
    let node = allNodes.find(n => n.id === id);
    if (node) return node;

    // 2. Case-insensitive id match
    const idLower = id.toLowerCase();
    node = allNodes.find(n => n.id.toLowerCase() === idLower);
    if (node) return node;

    // 3. Try matching by name if provided
    if (name) {
      const nameLower = name.toLowerCase();
      node = allNodes.find(n => n.name.toLowerCase() === nameLower);
      if (node) return node;

      // Normalized name match (remove separators)
      const normalizedName = nameLower.replace(/[-_\s]/g, '');
      node = allNodes.find(n =>
        n.name.toLowerCase().replace(/[-_\s]/g, '') === normalizedName ||
        n.id.toLowerCase().replace(/[-_\s]/g, '') === normalizedName
      );
      if (node) return node;
    }

    // 4. Partial matching as last resort
    const idLowerNorm = id.toLowerCase();
    node = allNodes.find(n =>
      n.id.toLowerCase().includes(idLowerNorm) ||
      idLowerNorm.includes(n.id.toLowerCase()) ||
      n.name.toLowerCase().includes(idLowerNorm)
    );

    return node;
  };

  // Memoized panel data - only recomputes when selectedNode or graph changes
  // Uses untrack() for nodes() to prevent physics updates from triggering re-renders
  const selectedPanelData = createMemo(() => {
    const sel = selectedNode();
    if (!sel) return null;

    const graphData = graph();
    if (!graphData) return null;

    // untrack: read nodes without creating dependency (physics updates 60x/sec)
    const allNodes = untrack(() => nodes());

    // Get dependencies this mod depends on (excluding incompatible)
    const dependsOnEdges = graphData.edges.filter(
      e => e.from === sel.id && e.dependency_type !== "incompatible"
    );
    const dependsOnMods = dependsOnEdges.map(e => {
      const node = findNodeByIdOrName(allNodes, e.to, e.to_name);
      return { name: e.to_name || e.to, type: e.dependency_type, node, is_problem: e.is_problem };
    });
    // Deduplicate by name (case-insensitive)
    const seenDeps = new Set<string>();
    const uniqueDependsOnMods = dependsOnMods.filter(m => {
      const key = m.name.toLowerCase();
      if (seenDeps.has(key)) return false;
      seenDeps.add(key);
      return true;
    });

    // Get incompatible mods
    const incompatibleEdges = graphData.edges.filter(
      e => e.from === sel.id && e.dependency_type === "incompatible"
    );
    const incompatibleMods = incompatibleEdges.map(e => {
      const node = findNodeByIdOrName(allNodes, e.to, e.to_name);
      return { name: e.to_name || e.to, node, is_problem: e.is_problem };
    });
    // Deduplicate by name
    const seenIncompat = new Set<string>();
    const uniqueIncompatibleMods = incompatibleMods.filter(m => {
      const key = m.name.toLowerCase();
      if (seenIncompat.has(key)) return false;
      seenIncompat.add(key);
      return true;
    });

    // Get mods that depend on this one (excluding incompatible - shown separately)
    const dependentEdges = graphData.edges.filter(
      e => e.to === sel.id && e.dependency_type !== "incompatible"
    );
    const dependentMods = dependentEdges.map(e => {
      let foundNode = findNodeByIdOrName(allNodes, e.from, e.from_name);
      return {
        name: foundNode?.name || e.from_name || e.from,
        type: e.dependency_type,
        node: foundNode
      };
    });
    // Deduplicate by name
    const seenDependent = new Set<string>();
    const uniqueDependentMods = dependentMods.filter(m => {
      const key = m.name.toLowerCase();
      if (seenDependent.has(key)) return false;
      seenDependent.add(key);
      return true;
    });

    return {
      sel,
      uniqueDependsOnMods,
      uniqueIncompatibleMods,
      uniqueDependentMods,
    };
  });

  // Track if component is mounted to prevent render() after cleanup
  let isMounted = true;

  // Icon cache for mod images with LRU eviction to prevent memory leaks
  const ICON_CACHE_MAX_SIZE = 200; // Maximum number of cached icons
  const iconCache = new Map<string, HTMLImageElement | null>();
  const iconAccessOrder: string[] = []; // Track access order for LRU eviction

  // LRU cache helper - evict oldest entries when cache is full
  const evictOldestIcons = () => {
    while (iconCache.size > ICON_CACHE_MAX_SIZE && iconAccessOrder.length > 0) {
      const oldestKey = iconAccessOrder.shift();
      if (oldestKey) {
        iconCache.delete(oldestKey);
      }
    }
  };

  // Update access order for LRU tracking
  const touchIconCache = (key: string) => {
    const idx = iconAccessOrder.indexOf(key);
    if (idx > -1) {
      iconAccessOrder.splice(idx, 1);
    }
    iconAccessOrder.push(key);
  };

  // Load icon for a node
  const loadIcon = (node: GraphNode): HTMLImageElement | null => {
    if (!node.icon_url) return null;

    if (iconCache.has(node.id)) {
      touchIconCache(node.id); // Update LRU order
      return iconCache.get(node.id) || null;
    }

    // Evict old entries if cache is full
    evictOldestIcons();

    // Mark as loading
    iconCache.set(node.id, null);
    touchIconCache(node.id);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      iconCache.set(node.id, img);
      touchIconCache(node.id);
      // Only render if component is still mounted (WebGL resources exist)
      if (isMounted) render();
    };
    img.onerror = () => {
      iconCache.set(node.id, null);
    };
    img.src = node.icon_url;

    return null;
  };

  // Refs
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let gl: WebGL2RenderingContext | null = null;
  let circleProgram: WebGLProgram | null = null;
  let lineProgram: WebGLProgram | null = null;
  let animationFrame: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let pendingGraphData: DependencyGraphData | null = null;

  // WebGL buffers
  let circleVAO: WebGLVertexArrayObject | null = null;
  let lineVAO: WebGLVertexArrayObject | null = null;
  let instanceBuffer: WebGLBuffer | null = null;
  let lineBuffer: WebGLBuffer | null = null;

  // Canvas for text labels (overlay)
  let labelCanvas: HTMLCanvasElement | undefined;
  let labelCtx: CanvasRenderingContext2D | null = null;

  // Initialize WebGL
  const initWebGL = (): boolean => {
    if (!canvasRef) return false;

    gl = canvasRef.getContext("webgl2", {
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });

    if (!gl) {
      if (import.meta.env.DEV) console.error("[DependencyGraph] WebGL2 not supported");
      return false;
    }

    // Compile shaders
    circleProgram = createProgram(gl, VERTEX_SHADER_CIRCLE, FRAGMENT_SHADER_CIRCLE);
    lineProgram = createProgram(gl, VERTEX_SHADER_LINE, FRAGMENT_SHADER_LINE);

    if (!circleProgram || !lineProgram) {
      if (import.meta.env.DEV) console.error("[DependencyGraph] Failed to create shader programs");
      return false;
    }

    // Create circle geometry (quad that will be instanced)
    const quadVertices = new Float32Array([
      -1.2, -1.2,
       1.2, -1.2,
      -1.2,  1.2,
       1.2, -1.2,
       1.2,  1.2,
      -1.2,  1.2,
    ]);

    // Circle VAO
    circleVAO = gl.createVertexArray();
    gl.bindVertexArray(circleVAO);

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(circleProgram, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer (will be updated each frame)
    instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);

    const centerLoc = gl.getAttribLocation(circleProgram, "a_center");
    const radiusLoc = gl.getAttribLocation(circleProgram, "a_radius");
    const colorLoc = gl.getAttribLocation(circleProgram, "a_color");
    const selectedLoc = gl.getAttribLocation(circleProgram, "a_selected");

    // Instance attributes: center(2) + radius(1) + color(4) + selected(1) = 8 floats
    const stride = 8 * 4;
    gl.enableVertexAttribArray(centerLoc);
    gl.vertexAttribPointer(centerLoc, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(centerLoc, 1);

    gl.enableVertexAttribArray(radiusLoc);
    gl.vertexAttribPointer(radiusLoc, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(radiusLoc, 1);

    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.enableVertexAttribArray(selectedLoc);
    gl.vertexAttribPointer(selectedLoc, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(selectedLoc, 1);

    gl.bindVertexArray(null);

    // Line VAO
    lineVAO = gl.createVertexArray();
    gl.bindVertexArray(lineVAO);

    lineBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);

    const linePosLoc = gl.getAttribLocation(lineProgram, "a_position");
    const lineColorLoc = gl.getAttribLocation(lineProgram, "a_color");

    // Line attributes: position(2) + color(4) = 6 floats
    const lineStride = 6 * 4;
    gl.enableVertexAttribArray(linePosLoc);
    gl.vertexAttribPointer(linePosLoc, 2, gl.FLOAT, false, lineStride, 0);

    gl.enableVertexAttribArray(lineColorLoc);
    gl.vertexAttribPointer(lineColorLoc, 4, gl.FLOAT, false, lineStride, 8);

    gl.bindVertexArray(null);

    // Enable blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return true;
  };

  const createShader = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      if (import.meta.env.DEV) console.error("Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const createProgram = (gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null => {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      if (import.meta.env.DEV) console.error("Program link error:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }

    return program;
  };

  // Load graph data (NO enrichment - useMods handles that)
  const loadGraph = async () => {
    setLoading(true);
    setError(null);
    setSimulationProgress(0);

    try {
      // Just load the graph - enrichment is handled by useMods on instance open
      const data = await invoke<DependencyGraphData>("get_dependency_graph", {
        instanceId: props.instanceId,
      });
      setGraph(data);

      // If canvas is ready, initialize nodes immediately
      // Otherwise, store data and wait for canvas
      if (canvasReady() && canvasRef && canvasRef.width > 0) {
        initializeNodes(data);
      } else {
        pendingGraphData = data;
      }
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  // Initialize node positions using extracted physics module
  const initializeNodes = (data: DependencyGraphData) => {
    if (!canvasRef || canvasRef.width === 0 || canvasRef.height === 0) {
      pendingGraphData = data;
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const canvas = { width: canvasRef.width, height: canvasRef.height, dpr };
    const graphNodes = createGraphNodes(data, canvas);

    setNodes(graphNodes);
    runForceSimulation(graphNodes, data.edges, canvas, {
      setNodes: (n) => setNodes(n),
      setSimulationProgress: (p) => setSimulationProgress(p),
      setLoading: (l) => setLoading(l),
      render,
      fitToScreen,
    });
  };

  // Live physics controller (extracted to graphPhysics.ts)
  let livePhysicsController: LivePhysicsController | null = null;

  const initLivePhysics = () => {
    livePhysicsController = createLivePhysics({
      getNodes: () => nodes(),
      getGraph: () => graph(),
      getCanvas: () => {
        if (!canvasRef || canvasRef.width === 0) return null;
        return { width: canvasRef.width, height: canvasRef.height, dpr: window.devicePixelRatio || 1 };
      },
      getFilters: () => ({
        showOrphans: showOrphans(),
        showLibraries: showLibraries(),
        showDisabled: showDisabled(),
      }),
      getDraggedNode: () => draggedNode(),
      setNodes: (n) => setNodes(n),
      render,
    });
  };

  // Start/stop live physics based on signal
  createEffect(() => {
    if (livePhysics()) {
      if (!livePhysicsController) initLivePhysics();
      livePhysicsController?.start();
    } else {
      livePhysicsController?.stop();
    }
  });

  // Invalidate physics active nodes cache when filter signals change
  createEffect(() => {
    showOrphans();
    showLibraries();
    showDisabled();
    livePhysicsController?.invalidateActiveNodes();
  });
  // Get node color
  const getNodeColor = (node: GraphNode): [number, number, number, number] => {
    if (!node.enabled) return [0.22, 0.25, 0.31, 1.0]; // gray
    if (node.is_library) return [0.39, 0.4, 0.95, 1.0]; // indigo
    if (node.source === "modrinth") return [0.11, 0.85, 0.42, 1.0]; // green
    if (node.source === "curseforge") return [0.95, 0.39, 0.21, 1.0]; // orange
    return [0.23, 0.51, 0.96, 1.0]; // blue
  };

  // Get edge color
  const getEdgeColor = (edge: DependencyEdge, visible: boolean): [number, number, number, number] => {
    // Incompatible edges are always red/orange (darker if not a problem, bright if conflict exists)
    if (edge.dependency_type === "incompatible") {
      return edge.is_problem && highlightProblems()
        ? [0.94, 0.27, 0.27, 0.9]  // bright red - conflict exists!
        : [0.6, 0.3, 0.2, 0.5];    // muted red/orange - potential conflict
    }
    if (edge.is_problem && highlightProblems()) return [0.94, 0.27, 0.27, 0.9];
    if (edge.dependency_type === "optional") return [0.3, 0.34, 0.39, 0.5];
    return visible ? [0.22, 0.25, 0.31, 0.7] : [0.12, 0.15, 0.18, 0.4];
  };

  // Render
  const render = () => {
    // Guard against calling render after component unmount
    if (!isMounted || !gl || !canvasRef || !circleProgram || !lineProgram) return;

    const graphData = graph();
    const graphNodes = nodes();
    if (!graphData) return;

    // Canvas dimensions (with DPR)
    const canvasWidth = canvasRef.width;
    const canvasHeight = canvasRef.height;

    if (canvasWidth === 0 || canvasHeight === 0) return;

    // CSS dimensions (for coordinate system - matches node positions)
    const dpr = window.devicePixelRatio || 1;
    const width = canvasWidth / dpr;
    const height = canvasHeight / dpr;

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0.078, 0.082, 0.09, 1.0); // #141517
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Filter visible nodes
    const visibleNodes = graphNodes.filter(n => {
      if (!showLibraries() && n.is_library) return false;
      if (!showDisabled() && !n.enabled) return false;
      // Hide orphans (mods with no dependencies and no dependents)
      if (!showOrphans() && n.dependency_count === 0 && n.dependent_count === 0) return false;
      return true;
    });
    const visibleIds = new Set(visibleNodes.map(n => n.id));


    const z = zoom();
    const px = panX();
    const py = panY();
    const selected = selectedNode();
    const hovered = hoveredNode();

    // Create node lookup map for O(1) access (instead of O(n) find)
    const nodeMap = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      nodeMap.set(node.id, node);
    }

    // Viewport culling: calculate visible bounds in world coordinates
    const viewLeft = -px / z;
    const viewTop = -py / z;
    const viewRight = (width - px) / z;
    const viewBottom = (height - py) / z;

    // Helper: check if node is in viewport (with margin for edges)
    const margin = 100; // Extra margin for edges
    const isInViewport = (x: number, y: number, r: number = 0) =>
      x + r > viewLeft - margin &&
      x - r < viewRight + margin &&
      y + r > viewTop - margin &&
      y - r < viewBottom + margin;

    // Draw edges
    const lineData: number[] = [];
    // Edge sampling: when zoomed out with many edges, skip some
    const edgeSampleRate = z < 0.5 && graphData.edges.length > 500 ? 2 : 1;
    let edgeIndex = 0;

    for (const edge of graphData.edges) {
      // Sample edges when zoomed out for performance
      edgeIndex++;
      if (edgeSampleRate > 1 && edgeIndex % edgeSampleRate !== 0) continue;

      if (!visibleIds.has(edge.from)) continue;

      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      // Skip edges where either node doesn't exist OR has invalid position (0,0 is suspicious)
      if (!fromNode || !toNode) continue;
      if (fromNode.x === 0 && fromNode.y === 0) continue;
      if (toNode.x === 0 && toNode.y === 0) continue;

      // Skip edges completely outside viewport
      if (!isInViewport(fromNode.x, fromNode.y) && !isInViewport(toNode.x, toNode.y)) continue;

      const isToVisible = visibleIds.has(edge.to);
      const color = getEdgeColor(edge, isToVisible);

      if (isToVisible) {
        // Full line
        lineData.push(fromNode.x, fromNode.y, ...color);
        lineData.push(toNode.x, toNode.y, ...color);
      } else {
        // Partial line towards hidden node
        const dx = toNode.x - fromNode.x;
        const dy = toNode.y - fromNode.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetX = fromNode.x + (dx / dist) * 60;
        const targetY = fromNode.y + (dy / dist) * 60;
        lineData.push(fromNode.x, fromNode.y, ...color);
        lineData.push(targetX, targetY, ...color);
      }
    }

    if (lineData.length > 0) {
      gl.useProgram(lineProgram);
      gl.uniform2f(gl.getUniformLocation(lineProgram, "u_resolution"), width, height);
      gl.uniform2f(gl.getUniformLocation(lineProgram, "u_pan"), px, py);
      gl.uniform1f(gl.getUniformLocation(lineProgram, "u_zoom"), z);

      gl.bindVertexArray(lineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, lineData.length / 6);
    }

    // Draw nodes - with viewport culling
    const instanceData: number[] = [];
    const visibleInViewport: GraphNode[] = [];
    for (const node of visibleNodes) {
      // Viewport culling for nodes
      if (!isInViewport(node.x, node.y, node.radius)) continue;

      const color = getNodeColor(node);
      const isSelected = selected?.id === node.id || hovered?.id === node.id ? 1.0 : 0.0;
      instanceData.push(node.x, node.y, node.radius, ...color, isSelected);
      visibleInViewport.push(node);
    }

    if (instanceData.length > 0) {
      gl.useProgram(circleProgram);
      gl.uniform2f(gl.getUniformLocation(circleProgram, "u_resolution"), width, height);
      gl.uniform2f(gl.getUniformLocation(circleProgram, "u_pan"), px, py);
      gl.uniform1f(gl.getUniformLocation(circleProgram, "u_zoom"), z);

      gl.bindVertexArray(circleVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instanceData), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, visibleInViewport.length);
    }

    gl.bindVertexArray(null);

    // Render labels on overlay canvas - only for nodes in viewport
    renderLabels(visibleInViewport);
  };

  // Render text labels and icons on a 2D canvas overlay
  const renderLabels = (visibleNodes: GraphNode[]) => {
    if (!labelCtx || !labelCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = labelCanvas.width / dpr;
    const height = labelCanvas.height / dpr;
    const z = zoom();
    const px = panX();
    const py = panY();
    const selected = selectedNode();
    const hovered = hoveredNode();

    labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);

    // Skip all label rendering when zoomed out too far (performance)
    if (z < 0.3) return;

    labelCtx.textAlign = "center";
    labelCtx.textBaseline = "top";

    // Pre-compute problem nodes set for O(1) lookup instead of O(e) per node
    const problemNodes = new Set<string>();
    if (highlightProblems() && z >= 0.4) {
      const graphData = graph();
      if (graphData) {
        for (const edge of graphData.edges) {
          if (edge.is_problem) {
            problemNodes.add(edge.from);
            problemNodes.add(edge.to);
          }
        }
      }
    }

    for (const node of visibleNodes) {
      const screenX = node.x * z + px;
      const screenY = node.y * z + py;
      const screenRadius = node.radius * z;

      // Skip if off-screen
      if (screenX < -100 || screenX > width + 100 || screenY < -100 || screenY > height + 100) continue;

      const isSelected = selected?.id === node.id;
      const isHovered = hovered?.id === node.id;

      // Draw mod icon if available and zoom > 0.5
      if (z > 0.5 && node.icon_url) {
        const icon = loadIcon(node);
        if (icon) {
          const iconSize = screenRadius * 1.4; // Icon slightly smaller than circle
          labelCtx.save();
          labelCtx.beginPath();
          labelCtx.arc(screenX, screenY, screenRadius * 0.85, 0, Math.PI * 2);
          labelCtx.clip();
          labelCtx.drawImage(
            icon,
            screenX - iconSize / 2,
            screenY - iconSize / 2,
            iconSize,
            iconSize
          );
          labelCtx.restore();
        }
      }

      // Only show labels at reasonable zoom
      if (z >= 0.4) {
        // Label
        labelCtx.font = isSelected || isHovered
          ? `bold ${Math.max(10, 11 * z)}px system-ui`
          : `${Math.max(9, 10 * z)}px system-ui`;
        labelCtx.fillStyle = isSelected || isHovered ? "#ffffff" : "#9ca3af";

        const label = node.name.length > 20 ? node.name.slice(0, 18) + "…" : node.name;
        const labelY = screenY + screenRadius + 4;
        labelCtx.fillText(label, screenX, labelY);
      }

      // Problem indicator - using pre-computed set for O(1) lookup
      if (problemNodes.size > 0 && problemNodes.has(node.id)) {
        const badgeX = screenX + screenRadius - 4;
        const badgeY = screenY - screenRadius + 4;
        labelCtx.beginPath();
        labelCtx.arc(badgeX, badgeY, 6 * z, 0, Math.PI * 2);
        labelCtx.fillStyle = "#ef4444";
        labelCtx.fill();
        labelCtx.fillStyle = "#ffffff";
        labelCtx.font = `bold ${8 * z}px system-ui`;
        labelCtx.textBaseline = "middle";
        labelCtx.fillText("!", badgeX, badgeY);
        labelCtx.textBaseline = "top";
      }

      // Pinned indicator - small pin icon on opposite corner
      if (node.pinned) {
        const pinBadgeX = screenX - screenRadius + 4;
        const pinBadgeY = screenY - screenRadius + 4;
        labelCtx.beginPath();
        labelCtx.arc(pinBadgeX, pinBadgeY, 5 * z, 0, Math.PI * 2);
        labelCtx.fillStyle = "#06b6d4"; // cyan-500
        labelCtx.fill();
        // Draw a simple pin shape (vertical line with circle on top)
        labelCtx.strokeStyle = "#ffffff";
        labelCtx.lineWidth = 1 * z;
        labelCtx.beginPath();
        labelCtx.moveTo(pinBadgeX, pinBadgeY - 2 * z);
        labelCtx.lineTo(pinBadgeX, pinBadgeY + 2 * z);
        labelCtx.stroke();
        labelCtx.beginPath();
        labelCtx.arc(pinBadgeX, pinBadgeY - 2 * z, 1.5 * z, 0, Math.PI * 2);
        labelCtx.fillStyle = "#ffffff";
        labelCtx.fill();
      }
    }
  };

  // Get node at screen position
  const getNodeAtPosition = (screenX: number, screenY: number): GraphNode | null => {
    const z = zoom();
    const px = panX();
    const py = panY();
    const worldX = (screenX - px) / z;
    const worldY = (screenY - py) / z;

    // Check in reverse order (top nodes first)
    const graphNodes = nodes();
    for (let i = graphNodes.length - 1; i >= 0; i--) {
      const node = graphNodes[i];
      // Filter same as render - only visible nodes are clickable
      if (!showLibraries() && node.is_library) continue;
      if (!showDisabled() && !node.enabled) continue;
      // Filter orphans (solo mods with no dependencies)
      if (!showOrphans() && node.dependency_count === 0 && node.dependent_count === 0) continue;

      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy < node.radius * node.radius) {
        return node;
      }
    }
    return null;
  };

  // Mouse handlers
  const handleMouseDown = (e: MouseEvent) => {
    const rect = canvasRef?.getBoundingClientRect();
    if (!rect) return;

    setWasDragged(false); // Reset drag tracking at start of new interaction

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);

    if (node) {
      setDraggedNode(node);
      setIsDragging(true);
      // Wake physics from stable state when user starts dragging
      livePhysicsController?.resetStability();
    } else {
      setIsPanning(true);
    }

    setLastMousePos({ x: e.clientX, y: e.clientY });
    startAnimationLoop();
  };

  const handleMouseMove = (e: MouseEvent) => {
    const rect = canvasRef?.getBoundingClientRect();
    if (!rect) return;

    if (isDragging()) {
      setWasDragged(true); // Mark that actual dragging occurred
      const dragged = draggedNode();
      if (dragged) {
        const z = zoom();
        const dx = (e.clientX - lastMousePos().x) / z;
        const dy = (e.clientY - lastMousePos().y) / z;

        const nodesCopy = [...nodes()];
        const idx = nodesCopy.findIndex(n => n.id === dragged.id);
        if (idx >= 0) {
          // Move the dragged node (keep current pinned state - don't auto-pin)
          nodesCopy[idx] = {
            ...nodesCopy[idx],
            x: nodesCopy[idx].x + dx,
            y: nodesCopy[idx].y + dy,
          };

          // Don't manually move neighbors - let physics handle it naturally
          // Physics will respond to the dragged node's movement through edge forces,
          // causing connected non-pinned nodes to follow smoothly

          setNodes(nodesCopy);
          setDraggedNode(nodesCopy[idx]);
        }
      }
      setLastMousePos({ x: e.clientX, y: e.clientY });
    } else if (isPanning()) {
      setWasDragged(true); // Mark that actual panning occurred
      const dx = e.clientX - lastMousePos().x;
      const dy = e.clientY - lastMousePos().y;
      setPanX(panX() + dx);
      setPanY(panY() + dy);
      setLastMousePos({ x: e.clientX, y: e.clientY });
    } else {
      // Hover detection
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const node = getNodeAtPosition(x, y);
      if (node?.id !== hoveredNode()?.id) {
        setHoveredNode(node);
        render();
      }
    }
  };

  const handleMouseUp = () => {
    // Invalidate cached activeNodes after drag — during drag, setNodes() creates
    // new objects each frame, making the cached references stale. Without this,
    // physics mutations go to old objects and are silently discarded.
    if (isDragging() && wasDragged()) {
      livePhysicsController?.invalidateActiveNodes();
    }
    setIsDragging(false);
    setIsPanning(false);
    setDraggedNode(null);
    stopAnimationLoop();
    render();
  };

  const handleClick = (e: MouseEvent) => {
    // Skip if drag/pan actually occurred (mouse moved while button down)
    if (wasDragged()) {
      setWasDragged(false);
      return;
    }

    const rect = canvasRef?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSelectedNode(getNodeAtPosition(x, y));
    render();
  };

  const handleDoubleClick = (e: MouseEvent) => {
    const rect = canvasRef?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);

    if (node) {
      // Double-click toggles pin state
      const nodesCopy = [...nodes()];
      const idx = nodesCopy.findIndex(n => n.id === node.id);
      if (idx >= 0) {
        nodesCopy[idx] = { ...nodesCopy[idx], pinned: !nodesCopy[idx].pinned };
        setNodes(nodesCopy);
        // Invalidate cache — setNodes created new objects, old activeNodes refs are stale
        livePhysicsController?.invalidateActiveNodes();
        render();
      }
    }
  };

  const unpinAllNodes = () => {
    const nodesCopy = nodes().map(n => ({ ...n, pinned: false }));
    setNodes(nodesCopy);
    livePhysicsController?.invalidateActiveNodes();
    render();
  };

  const hasPinnedNodes = () => nodes().some(n => n.pinned);

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.2, Math.min(4, zoom() * delta));

    const rect = canvasRef?.getBoundingClientRect();
    if (rect) {
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const zoomRatio = newZoom / zoom();
      setPanX(x - (x - panX()) * zoomRatio);
      setPanY(y - (y - panY()) * zoomRatio);
    }

    setZoom(newZoom);
    render();
  };

  const startAnimationLoop = () => {
    if (animationFrame) return;
    const loop = () => {
      render();
      if (isDragging() || isPanning()) {
        animationFrame = requestAnimationFrame(loop);
      }
    };
    animationFrame = requestAnimationFrame(loop);
  };

  const stopAnimationLoop = () => {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  };

  const handleResize = () => {
    if (!containerRef || !canvasRef || !labelCanvas) return;

    const width = containerRef.clientWidth;
    const height = containerRef.clientHeight;

    if (width === 0 || height === 0) return;

    // Set canvas sizes
    const dpr = window.devicePixelRatio || 1;
    canvasRef.width = width * dpr;
    canvasRef.height = height * dpr;
    canvasRef.style.width = `${width}px`;
    canvasRef.style.height = `${height}px`;

    labelCanvas.width = width * dpr;
    labelCanvas.height = height * dpr;
    labelCanvas.style.width = `${width}px`;
    labelCanvas.style.height = `${height}px`;

    // Reset label context transform and scale
    labelCtx = labelCanvas.getContext("2d");
    if (labelCtx) {
      labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Mark canvas as ready
    if (!canvasReady()) {
      setCanvasReady(true);
    }

    // Initialize pending graph data
    if (pendingGraphData && width > 0 && height > 0) {
      const data = pendingGraphData;
      pendingGraphData = null;
      initializeNodes(data);
    } else {
      render();
    }
  };

  const analyzeRemoval = async () => {
    const selected = selectedNode();
    if (!selected) return;

    try {
      const analysis = await invoke<ModRemovalAnalysis>("analyze_mod_removal", {
        instanceId: props.instanceId,
        modSlug: selected.id,
      });
      setRemovalAnalysis(analysis);
      setShowRemovalDialog(true);
    } catch (e) {
      if (import.meta.env.DEV) console.error("Failed to analyze removal:", e);
    }
  };

  const resetView = () => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
    render();
  };

  const fitToScreen = () => {
    if (!canvasRef) return;
    const graphNodes = nodes();
    if (graphNodes.length === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvasRef.width / dpr;
    const canvasHeight = canvasRef.height / dpr;

    if (canvasWidth === 0 || canvasHeight === 0) return;

    // Calculate bounds
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const node of graphNodes) {
      minX = Math.min(minX, node.x - node.radius);
      maxX = Math.max(maxX, node.x + node.radius);
      minY = Math.min(minY, node.y - node.radius);
      maxY = Math.max(maxY, node.y + node.radius);
    }

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;

    if (graphWidth <= 0 || graphHeight <= 0 || !isFinite(minX) || !isFinite(maxX)) return;

    const padding = 60;
    const scaleX = (canvasWidth - padding * 2) / graphWidth;
    const scaleY = (canvasHeight - padding * 2) / graphHeight;
    const newZoom = Math.min(scaleX, scaleY, 2);

    // Guard against NaN
    if (!isFinite(newZoom) || newZoom <= 0) return;

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    setZoom(newZoom);
    setPanX(canvasWidth / 2 - centerX * newZoom);
    setPanY(canvasHeight / 2 - centerY * newZoom);
    render();
  };

  // Search functions
  const openSearch = () => {
    setSearchOpen(true);
    setSearchQuery("");
    setSearchResults([]);
    setSearchIndex(0);
    // Focus input after it renders
    requestAnimationFrame(() => {
      searchInputRef?.focus();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  const performSearch = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      setSearchIndex(0);
      return;
    }

    const q = query.toLowerCase();
    const results = nodes().filter(n =>
      n.name.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q)
    );
    setSearchResults(results);
    setSearchIndex(0);

    // Focus on first result
    if (results.length > 0) {
      focusOnNode(results[0]);
    }
  };

  const focusOnNode = (node: GraphNode) => {
    if (!canvasRef) return;

    // Auto-enable filters if the node would be hidden
    if (node.is_library && !showLibraries()) setShowLibraries(true);
    if (!node.enabled && !showDisabled()) setShowDisabled(true);
    if (node.dependency_count === 0 && node.dependent_count === 0 && !showOrphans()) {
      setShowOrphans(true);
    }

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvasRef.width / dpr;
    const canvasHeight = canvasRef.height / dpr;

    // Center on node with nice zoom level
    const targetZoom = Math.max(zoom(), 1.2);
    setZoom(targetZoom);
    setPanX(canvasWidth / 2 - node.x * targetZoom);
    setPanY(canvasHeight / 2 - node.y * targetZoom);
    setSelectedNode(node);
    render();
  };

  const nextSearchResult = () => {
    const results = searchResults();
    if (results.length === 0) return;
    const newIndex = (searchIndex() + 1) % results.length;
    setSearchIndex(newIndex);
    focusOnNode(results[newIndex]);
  };

  const prevSearchResult = () => {
    const results = searchResults();
    if (results.length === 0) return;
    const newIndex = (searchIndex() - 1 + results.length) % results.length;
    setSearchIndex(newIndex);
    focusOnNode(results[newIndex]);
  };

  // Keyboard handler for search (ESC and Enter only - Ctrl+F handled globally)
  const handleKeyDown = (e: KeyboardEvent) => {
    // Escape to close search
    if (e.key === "Escape" && searchOpen()) {
      closeSearch();
      return;
    }

    // Enter to go to next result, Shift+Enter for previous
    if (e.key === "Enter" && searchOpen()) {
      e.preventDefault();
      if (e.shiftKey) {
        prevSearchResult();
      } else {
        nextSearchResult();
      }
      return;
    }
  };
  onMount(() => {
    // Register search handler for global Ctrl+F
    registerSearchHandler("dependency-graph", openSearch, 10); // Higher priority when graph is open

    // Add keyboard listener for ESC and Enter
    document.addEventListener("keydown", handleKeyDown);
    // Initialize label canvas context
    if (labelCanvas) {
      labelCtx = labelCanvas.getContext("2d");
    }

    // Setup ResizeObserver
    resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    if (containerRef) {
      resizeObserver.observe(containerRef);
    }

    // Initialize WebGL after a small delay to ensure DOM is ready
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (initWebGL()) {
          handleResize();
          // First load: enrich=true to fetch dependencies from API
          loadGraph();
        } else {
          setError("WebGL2 is not supported in your browser");
          setLoading(false);
        }
      });
    });
  });

  onCleanup(() => {
    // Mark as unmounted FIRST to prevent any async callbacks from using deleted resources
    isMounted = false;

    // Unregister search handler
    unregisterSearchHandler("dependency-graph");

    document.removeEventListener("keydown", handleKeyDown);
    resizeObserver?.disconnect();
    stopAnimationLoop();

    // Stop live physics
    livePhysicsController?.destroy();

    // Cleanup WebGL resources
    if (gl) {
      if (circleVAO) gl.deleteVertexArray(circleVAO);
      if (lineVAO) gl.deleteVertexArray(lineVAO);
      if (instanceBuffer) gl.deleteBuffer(instanceBuffer);
      if (lineBuffer) gl.deleteBuffer(lineBuffer);
      if (circleProgram) gl.deleteProgram(circleProgram);
      if (lineProgram) gl.deleteProgram(lineProgram);
    }
  });
  // Re-render when filters change
  createEffect(() => {
    showLibraries();
    showDisabled();
    highlightProblems();
    showOrphans();
    render();
  });

  return (
    <div class="flex flex-col w-full h-full bg-gray-900 rounded-xl overflow-hidden">
      {/* Header */}
      <div class="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-gray-850 border-b border-gray-700">
        <div class="flex items-center gap-3">
          <i class="i-hugeicons-chart-relationship w-5 h-5 text-blue-400" />
          <h2 class="text-lg font-medium text-white">
            {t().mods?.dependencyGraph?.title || "Dependency Graph"}
          </h2>
          <Show when={graph()}>
            <span class="text-sm text-gray-400">
              ({graph()!.nodes.length} {t().mods?.title?.toLowerCase() || "mods"}, {graph()!.edges.length} deps)
            </span>
          </Show>
        </div>

        <div class="flex items-center gap-1.5">
          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
            <input
              type="checkbox"
              checked={showLibraries()}
              onChange={(e) => setShowLibraries(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.libs || "Libs"}
          </label>

          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
            <input
              type="checkbox"
              checked={showDisabled()}
              onChange={(e) => setShowDisabled(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.disabled || "Off"}
          </label>

          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
            <input
              type="checkbox"
              checked={highlightProblems()}
              onChange={(e) => setHighlightProblems(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.issues || "Issues"}
          </label>

          <Tooltip text="Show mods without any dependencies" position="bottom">
            <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
              <input
                type="checkbox"
                checked={showOrphans()}
                onChange={(e) => setShowOrphans(e.currentTarget.checked)}
                class="w-3 h-3 rounded border-gray-600 bg-gray-700 focus:ring-0"
              />
              {t().mods?.dependencyGraph?.filters?.solo || "Solo"}
            </label>
          </Tooltip>

          <div class="w-px h-4 bg-gray-700 mx-0.5" />

          <Tooltip text={livePhysics() ? "Остановить физику" : "Включить физику (реальное время)"} position="bottom">
            <button
              onClick={() => setLivePhysics(!livePhysics())}
              class={`p-2 flex items-center justify-center rounded-full transition-colors ${
                livePhysics()
                  ? "text-green-400 bg-green-500/20 hover:bg-green-500/30"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              <i class={livePhysics() ? "i-hugeicons-stop w-3 h-3" : "i-hugeicons-play w-3 h-3"} />
            </button>
          </Tooltip>

          <Show when={hasPinnedNodes()}>
            <Tooltip text="Открепить все узлы (двойной клик на узел = открепить)" position="bottom">
              <button
                onClick={unpinAllNodes}
                class="p-2 flex items-center justify-center text-yellow-400 hover:text-yellow-300 hover:bg-yellow-500/20 rounded-full transition-colors"
              >
                <i class="i-hugeicons-pin-off w-3 h-3" />
              </button>
            </Tooltip>
          </Show>

          <Tooltip text={t().mods?.dependencyGraph?.tooltips?.search || "Search (Ctrl+F)"} position="bottom">
            <button
              onClick={openSearch}
              class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            >
              <i class="i-hugeicons-search-01 w-3 h-3" />
            </button>
          </Tooltip>

          <Tooltip text={t().mods?.dependencyGraph?.tooltips?.fitToScreen || "Fit to screen"} position="bottom">
            <button
              onClick={fitToScreen}
              class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            >
              <i class="i-hugeicons-arrow-expand-02 w-3 h-3" />
            </button>
          </Tooltip>

          <Tooltip text={t().mods?.dependencyGraph?.tooltips?.resetView || "Reset view"} position="bottom">
            <button
              onClick={resetView}
              class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            >
              <i class="i-hugeicons-home-01 w-3 h-3" />
            </button>
          </Tooltip>

          <Show when={props.onClose}>
            <button
              onClick={props.onClose}
              class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            >
              <i class="i-hugeicons-cancel-01 w-3 h-3" />
            </button>
          </Show>
        </div>
      </div>

      {/* Main content */}
      <div class="flex flex-1 min-h-0">
        {/* Canvas container */}
        <div ref={containerRef} class="flex-1 overflow-hidden">
          <Show when={loading()}>
            <div class="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/95 z-20">
              <i class="i-svg-spinners-ring-resize w-10 h-10 text-[var(--color-primary)] mb-3" />
              <Show when={simulationProgress() > 0}>
                <div class="text-sm text-gray-400 mb-2">
                  {t().mods?.dependencyGraph?.calculatingLayout || "Calculating layout..."} {simulationProgress()}%
                </div>
                <div class="w-48 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-[var(--color-primary)] transition-all duration-150"
                    style={{ width: `${simulationProgress()}%` }}
                  />
                </div>
              </Show>
              <Show when={simulationProgress() === 0}>
                <div class="text-sm text-gray-400">
                  {t().mods?.dependencyGraph?.loadingData || "Loading graph data..."}
                </div>
              </Show>
            </div>
          </Show>

          <Show when={error()}>
            <div class="absolute inset-0 flex items-center justify-center bg-gray-900/95 z-20">
              <div class="flex flex-col items-center gap-4 text-center max-w-md px-4">
                <i class="i-hugeicons-alert-02 w-12 h-12 text-red-400" />
                <p class="text-red-400 text-sm">{error()}</p>
                <button
                  onClick={() => loadGraph()}
                  class="btn-primary px-4 py-2 text-sm rounded-lg"
                >
                  Try Again
                </button>
              </div>
            </div>
          </Show>

          {/* WebGL canvas */}
          <canvas
            ref={canvasRef}
            class="absolute inset-0 cursor-grab active:cursor-grabbing"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
            onDblClick={handleDoubleClick}
            onWheel={handleWheel}
          />

          {/* Label overlay canvas */}
          <canvas
            ref={labelCanvas}
            class="absolute inset-0 pointer-events-none"
          />

          {/* Search overlay */}
          <Show when={searchOpen()}>
            <div class="absolute top-4 left-1/2 -translate-x-1/2 z-30 w-80">
              <div class="bg-gray-800/95 backdrop-blur-sm rounded-lg border border-gray-700 shadow-xl overflow-hidden">
                <div class="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
                  <i class="i-hugeicons-search-01 w-4 h-4 text-gray-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery()}
                    onInput={(e) => performSearch(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        closeSearch();
                      }
                    }}
                    placeholder={t().mods?.dependencyGraph?.search?.placeholder || "Search mods..."}
                    class="flex-1 bg-transparent text-sm text-white placeholder-gray-500 outline-none"
                  />
                  <Show when={searchResults().length > 0}>
                    <span class="text-xs text-gray-400">
                      {searchIndex() + 1}/{searchResults().length}
                    </span>
                    <div class="flex items-center gap-0.5">
                      <Tooltip text={t().mods?.dependencyGraph?.search?.prev || "Previous (Shift+Enter)"} position="bottom">
                        <button
                          onClick={prevSearchResult}
                          class="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700/50"
                        >
                          <i class="i-hugeicons-arrow-up-01 w-3 h-3" />
                        </button>
                      </Tooltip>
                      <Tooltip text={t().mods?.dependencyGraph?.search?.next || "Next (Enter)"} position="bottom">
                        <button
                          onClick={nextSearchResult}
                          class="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700/50"
                        >
                          <i class="i-hugeicons-arrow-down-01 w-3 h-3" />
                        </button>
                      </Tooltip>
                    </div>
                  </Show>
                  <button
                    onClick={closeSearch}
                    class="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700/50"
                  >
                    <i class="i-hugeicons-cancel-01 w-3 h-3" />
                  </button>
                </div>
                <Show when={searchQuery() && searchResults().length === 0}>
                  <div class="px-3 py-2 text-xs text-gray-500">
                    {t().mods?.dependencyGraph?.search?.noResults || "No mods found"}
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          {/* Legend */}
          <div class="absolute bottom-4 left-4 p-3 bg-gray-800/95 backdrop-blur-sm rounded-lg border border-gray-700">
            <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-gray-300">
              <div class="flex items-center gap-2">
                <div class="w-3 h-3 rounded-full" style="background-color: #1bd96a" />
                <span>{t().mods?.dependencyGraph?.legend?.modrinth || "Modrinth"}</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="w-3 h-3 rounded-full" style="background-color: #f16436" />
                <span>{t().mods?.dependencyGraph?.legend?.curseforge || "CurseForge"}</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="w-3 h-3 rounded-full" style="background-color: #6366f1" />
                <span>{t().mods?.dependencyGraph?.legend?.library || "Библиотека"}</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="w-3 h-3 rounded-full" style="background-color: #383d47" />
                <span>{t().mods?.dependencyGraph?.legend?.disabled || "Выключен"}</span>
              </div>
            </div>
          </div>

          {/* Zoom indicator */}
          <div class="absolute bottom-4 right-4 px-3 py-1.5 bg-gray-800/95 backdrop-blur-sm rounded-lg border border-gray-700 text-xs text-gray-400">
            {Math.round(zoom() * 100)}%
          </div>
        </div>


        {/* Selected node panel — extracted to GraphNodePanel */}
        <Show when={selectedPanelData()} keyed>
          {(data) => (
            <GraphNodePanel
              data={data}
              onFocusNode={focusOnNode}
              onAnalyzeRemoval={analyzeRemoval}
              t={t}
            />
          )}
        </Show>
      </div>

      {/* Removal analysis dialog — extracted to RemovalAnalysisDialog */}
      <Show when={showRemovalDialog() && removalAnalysis()}>
        <RemovalAnalysisDialog
          analysis={removalAnalysis}
          onClose={() => setShowRemovalDialog(false)}
          t={t}
        />
      </Show>
    </div>
  );
}
