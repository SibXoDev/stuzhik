import { createSignal, createEffect, createMemo, onMount, onCleanup, For, Show, untrack } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../shared/i18n";
import { ModalWrapper } from "../../../shared/ui";
import { registerSearchHandler, unregisterSearchHandler } from "../../../shared/stores";

// Types
interface DependencyNode {
  id: string;
  name: string;
  enabled: boolean;
  version: string;
  icon_url: string | null;
  source: string;
  dependency_count: number;
  dependent_count: number;
  is_library: boolean;
}

interface DependencyEdge {
  from: string;
  from_name?: string; // Optional - backend might not provide it
  to: string;
  to_name: string;
  dependency_type: string;
  version_requirement: string | null;
  is_satisfied: boolean;
  is_problem: boolean;
}

interface DependencyGraphData {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

interface ModRemovalAnalysis {
  mod_slug: string;
  is_safe: boolean;
  affected_mods: AffectedMod[];
  warning_mods: AffectedMod[];
  total_affected: number;
  recommendation: string;
}

interface AffectedMod {
  slug: string;
  name: string;
  impact: string;
  reason: string;
}

// Internal node with position for rendering
interface GraphNode extends DependencyNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned: boolean; // If true, physics won't move this node
}

interface Props {
  instanceId: string;
  onClose?: () => void;
}

// WebGL2 Shaders
const VERTEX_SHADER_CIRCLE = `#version 300 es
  in vec2 a_position;
  in vec2 a_center;
  in float a_radius;
  in vec4 a_color;
  in float a_selected;

  uniform vec2 u_resolution;
  uniform vec2 u_pan;
  uniform float u_zoom;

  out vec4 v_color;
  out vec2 v_position;
  out float v_radius;
  out float v_selected;

  void main() {
    vec2 worldPos = a_center + a_position * a_radius;
    vec2 screenPos = (worldPos * u_zoom + u_pan) / u_resolution * 2.0 - 1.0;
    screenPos.y *= -1.0;

    gl_Position = vec4(screenPos, 0.0, 1.0);
    v_color = a_color;
    v_position = a_position;
    v_radius = a_radius;
    v_selected = a_selected;
  }
`;

const FRAGMENT_SHADER_CIRCLE = `#version 300 es
  precision highp float;

  in vec4 v_color;
  in vec2 v_position;
  in float v_radius;
  in float v_selected;

  out vec4 fragColor;

  void main() {
    float dist = length(v_position);

    // Anti-aliased circle
    float edge = fwidth(dist);
    float alpha = 1.0 - smoothstep(1.0 - edge * 2.0, 1.0, dist);

    if (alpha < 0.01) discard;

    // Border
    float borderWidth = 0.08;
    float borderInner = 1.0 - borderWidth;

    vec4 borderColor = v_selected > 0.5 ? vec4(1.0, 1.0, 1.0, 1.0) : vec4(0.06, 0.06, 0.07, 1.0);
    float borderAlpha = smoothstep(borderInner - edge, borderInner, dist);

    vec4 finalColor = mix(v_color, borderColor, borderAlpha);
    finalColor.a *= alpha;

    // Glow for selected
    if (v_selected > 0.5) {
      float glowDist = dist - 1.0;
      float glow = exp(-glowDist * 3.0) * 0.5;
      finalColor.rgb += v_color.rgb * glow;
    }

    fragColor = finalColor;
  }
`;

const VERTEX_SHADER_LINE = `#version 300 es
  in vec2 a_position;
  in vec4 a_color;

  uniform vec2 u_resolution;
  uniform vec2 u_pan;
  uniform float u_zoom;

  out vec4 v_color;

  void main() {
    vec2 screenPos = (a_position * u_zoom + u_pan) / u_resolution * 2.0 - 1.0;
    screenPos.y *= -1.0;
    gl_Position = vec4(screenPos, 0.0, 1.0);
    v_color = a_color;
  }
`;

const FRAGMENT_SHADER_LINE = `#version 300 es
  precision highp float;
  in vec4 v_color;
  out vec4 fragColor;
  void main() {
    fragColor = v_color;
  }
`;

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
  let physicsFrame: number | null = null;
  let physicsAdjacency: Map<string, Set<string>> | null = null;
  let physicsNodeMap: Map<string, GraphNode> | null = null;

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
      console.error("[DependencyGraph] WebGL2 not supported");
      return false;
    }

    // Compile shaders
    circleProgram = createProgram(gl, VERTEX_SHADER_CIRCLE, FRAGMENT_SHADER_CIRCLE);
    lineProgram = createProgram(gl, VERTEX_SHADER_LINE, FRAGMENT_SHADER_LINE);

    if (!circleProgram || !lineProgram) {
      console.error("[DependencyGraph] Failed to create shader programs");
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
      console.error("Shader compile error:", gl.getShaderInfoLog(shader));
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
      console.error("Program link error:", gl.getProgramInfoLog(program));
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

  // Initialize node positions
  const initializeNodes = (data: DependencyGraphData) => {
    if (!canvasRef || canvasRef.width === 0 || canvasRef.height === 0) {
      pendingGraphData = data;
      return;
    }

    // Use CSS dimensions (not canvas dimensions with DPR) for node coordinates
    // This ensures consistency with pan/zoom calculations
    const dpr = window.devicePixelRatio || 1;
    const width = canvasRef.width / dpr;
    const height = canvasRef.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    // Calculate radius based on node importance
    const getRadius = (node: DependencyNode): number => {
      if (node.is_library || node.dependent_count > 5) return 28;
      if (node.dependent_count > 2) return 22;
      return 18;
    };

    // Place nodes in a spiral for better initial distribution
    const graphNodes: GraphNode[] = data.nodes.map((node, i) => {
      const angle = i * 0.5;
      const radius = 50 + i * 3;
      return {
        ...node,
        x: centerX + Math.cos(angle) * Math.min(radius, Math.min(width, height) * 0.4),
        y: centerY + Math.sin(angle) * Math.min(radius, Math.min(width, height) * 0.4),
        vx: 0,
        vy: 0,
        radius: getRadius(node),
        pinned: false,
      };
    });

    setNodes(graphNodes);
    runForceSimulation(graphNodes, data.edges);
  };

  // Force simulation with collision detection
  const runForceSimulation = (graphNodes: GraphNode[], edges: DependencyEdge[]) => {
    if (!canvasRef || canvasRef.width === 0) {
      return;
    }

    // Use CSS dimensions for simulation (same as initializeNodes)
    const dpr = window.devicePixelRatio || 1;
    const width = canvasRef.width / dpr;
    const height = canvasRef.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    // Build adjacency maps
    const dependsOn = new Map<string, Set<string>>(); // node -> its dependencies
    const dependedBy = new Map<string, Set<string>>(); // node -> nodes that depend on it
    const nodeMap = new Map<string, GraphNode>();

    for (const node of graphNodes) {
      nodeMap.set(node.id, node);
      dependsOn.set(node.id, new Set());
      dependedBy.set(node.id, new Set());
    }

    for (const edge of edges) {
      if (edge.dependency_type === "required" || edge.dependency_type === "optional") {
        // from depends on to
        dependsOn.get(edge.from)?.add(edge.to);
        dependedBy.get(edge.to)?.add(edge.from);
      }
    }

    // Compute dependency levels (topological sort)
    // Level 0 = libraries (no dependencies or very few), higher levels = more dependent
    const levels = new Map<string, number>();
    const computeLevel = (nodeId: string, visited: Set<string>): number => {
      if (levels.has(nodeId)) return levels.get(nodeId)!;
      if (visited.has(nodeId)) return 0; // cycle detection
      visited.add(nodeId);

      const deps = dependsOn.get(nodeId) || new Set();
      if (deps.size === 0) {
        levels.set(nodeId, 0);
        return 0;
      }

      let maxDepLevel = 0;
      for (const depId of deps) {
        if (nodeMap.has(depId)) {
          maxDepLevel = Math.max(maxDepLevel, computeLevel(depId, visited) + 1);
        }
      }
      levels.set(nodeId, maxDepLevel);
      return maxDepLevel;
    };

    for (const node of graphNodes) {
      computeLevel(node.id, new Set());
    }

    // Group nodes by level
    const maxLevel = Math.max(...Array.from(levels.values()), 0);
    const nodesByLevel: GraphNode[][] = Array.from({ length: maxLevel + 1 }, () => []);
    for (const node of graphNodes) {
      const level = levels.get(node.id) || 0;
      nodesByLevel[level].push(node);
    }

    // Initial placement: place by level in concentric rings
    // Level 0 (hubs/libraries) in center, higher levels outward
    const maxRadius = Math.min(width, height) * 0.45;

    for (let level = 0; level <= maxLevel; level++) {
      const nodesAtLevel = nodesByLevel[level];
      if (nodesAtLevel.length === 0) continue;

      // Ring radius increases with level
      const ringRadius = level === 0
        ? Math.min(width, height) * 0.1
        : (level / (maxLevel || 1)) * maxRadius;

      // Sort nodes at this level by their primary dependency for better grouping
      nodesAtLevel.sort((a, b) => {
        const aDeps = Array.from(dependsOn.get(a.id) || []);
        const bDeps = Array.from(dependsOn.get(b.id) || []);
        return (aDeps[0] || "").localeCompare(bDeps[0] || "");
      });

      // Place nodes around the ring
      nodesAtLevel.forEach((node, i) => {
        const angle = (i / nodesAtLevel.length) * Math.PI * 2 - Math.PI / 2;
        const jitter = (Math.random() - 0.5) * 20;
        node.x = centerX + Math.cos(angle) * (ringRadius + jitter);
        node.y = centerY + Math.sin(angle) * (ringRadius + jitter);
      });
    }

    // Build bidirectional adjacency for force simulation
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
      adjacency.get(edge.from)!.add(edge.to);
      adjacency.get(edge.to)!.add(edge.from);
    }

    const TOTAL_ITERATIONS = 250; // More iterations for complex graphs
    const ITERATIONS_PER_CHUNK = 5;
    let currentIteration = 0;

    const runChunk = () => {
      const endIteration = Math.min(currentIteration + ITERATIONS_PER_CHUNK, TOTAL_ITERATIONS);
      const alpha = Math.pow(1 - currentIteration / TOTAL_ITERATIONS, 2); // Quadratic decay

      for (let iter = currentIteration; iter < endIteration; iter++) {
        for (let i = 0; i < graphNodes.length; i++) {
          const node = graphNodes[i];
          let fx = 0;
          let fy = 0;

          // Repulsion from all nodes (weaker for connected nodes)
          for (let j = 0; j < graphNodes.length; j++) {
            if (i === j) continue;
            const other = graphNodes[j];
            let dx = node.x - other.x;
            let dy = node.y - other.y;

            if (dx === 0 && dy === 0) {
              dx = (Math.random() - 0.5) * 2;
              dy = (Math.random() - 0.5) * 2;
            }

            const distSq = dx * dx + dy * dy;
            const dist = Math.sqrt(distSq);

            // Weaker repulsion for connected nodes
            const isConnected = adjacency.get(node.id)?.has(other.id);
            const repulsionStrength = isConnected ? 3000 : 5000;
            const minDistSq = 400;
            const effectiveDistSq = Math.max(distSq, minDistSq);
            const repulsion = repulsionStrength / effectiveDistSq;
            fx += (dx / dist) * repulsion;
            fy += (dy / dist) * repulsion;

            // Collision resolution
            const minDist = node.radius + other.radius + 15;
            if (dist < minDist && dist > 0) {
              const overlap = minDist - dist;
              const pushX = (dx / dist) * overlap * 0.5;
              const pushY = (dy / dist) * overlap * 0.5;
              node.x += pushX;
              node.y += pushY;
              other.x -= pushX;
              other.y -= pushY;
            }
          }

          // STRONG attraction along edges - this is key for grouping!
          const neighbors = adjacency.get(node.id);
          if (neighbors) {
            for (const otherId of neighbors) {
              const other = nodeMap.get(otherId);
              if (!other) continue;

              let dx = other.x - node.x;
              let dy = other.y - node.y;

              if (dx === 0 && dy === 0) {
                dx = (Math.random() - 0.5) * 2;
                dy = (Math.random() - 0.5) * 2;
              }

              const dist = Math.sqrt(dx * dx + dy * dy);
              // Target distance: closer for connected nodes
              const targetDist = node.radius + other.radius + 80;
              // Strong attraction force
              const force = (dist - targetDist) * 0.08;
              fx += (dx / dist) * force;
              fy += (dy / dist) * force;
            }
          }

          // Weak center gravity
          fx += (centerX - node.x) * 0.001;
          fy += (centerY - node.y) * 0.001;

          // No hard boundaries - nodes can spread freely, use pan/zoom

          // Apply velocity with strong damping
          node.vx = (node.vx + fx * alpha * 0.4) * 0.8;
          node.vy = (node.vy + fy * alpha * 0.4) * 0.8;

          // Velocity cap (prevents oscillation)
          const maxVelocity = 20;
          const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
          if (speed > maxVelocity) {
            node.vx = (node.vx / speed) * maxVelocity;
            node.vy = (node.vy / speed) * maxVelocity;
          }

          node.x += node.vx;
          node.y += node.vy;

          // NaN check - reset to center if corrupted
          if (!isFinite(node.x) || !isFinite(node.y)) {
            node.x = centerX + (Math.random() - 0.5) * 100;
            node.y = centerY + (Math.random() - 0.5) * 100;
            node.vx = 0;
            node.vy = 0;
          }

          // Soft safety clamp (only for extreme cases, with margin)
          const safetyMargin = node.radius;
          node.x = Math.max(safetyMargin, Math.min(width - safetyMargin, node.x));
          node.y = Math.max(safetyMargin, Math.min(height - safetyMargin, node.y));
        }
      }

      currentIteration = endIteration;
      setSimulationProgress(Math.round((currentIteration / TOTAL_ITERATIONS) * 100));
      setNodes([...graphNodes]);
      render();

      if (currentIteration < TOTAL_ITERATIONS) {
        requestAnimationFrame(runChunk);
      } else {
        setLoading(false);
        // Auto fit after simulation
        fitToScreen();
      }
    };

    runChunk();
  };

  // Live physics loop - runs continuously when enabled
  const runLivePhysics = () => {
    if (!livePhysics() || !canvasRef || canvasRef.width === 0) {
      physicsFrame = null;
      return;
    }

    const graphNodes = nodes();
    const graphData = graph();
    if (!graphData || graphNodes.length === 0) {
      physicsFrame = requestAnimationFrame(runLivePhysics);
      return;
    }

    // Build adjacency (cached) and node map (updated every frame to reflect drag changes)
    if (!physicsAdjacency) {
      physicsAdjacency = new Map<string, Set<string>>();
      for (const edge of graphData.edges) {
        if (!physicsAdjacency.has(edge.from)) physicsAdjacency.set(edge.from, new Set());
        if (!physicsAdjacency.has(edge.to)) physicsAdjacency.set(edge.to, new Set());
        physicsAdjacency.get(edge.from)!.add(edge.to);
        physicsAdjacency.get(edge.to)!.add(edge.from);
      }
    }

    // Rebuild node map every frame to get current positions from signal
    physicsNodeMap = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      physicsNodeMap.set(node.id, node);
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvasRef.width / dpr;
    const height = canvasRef.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    const currentDraggedNode = draggedNode();

    // Adjust physics parameters based on window size
    const minDimension = Math.min(width, height);
    const isSmallWindow = minDimension < 400;
    const alpha = isSmallWindow ? 0.15 : 0.3; // Weaker forces for small windows
    const damping = isSmallWindow ? 0.7 : 0.85; // Stronger damping for small windows
    const maxVelocity = isSmallWindow ? 5 : 15; // Limit max velocity for small windows

    // Single physics step
    for (let i = 0; i < graphNodes.length; i++) {
      const node = graphNodes[i];

      // Skip dragged node - it's being moved by user
      if (currentDraggedNode && node.id === currentDraggedNode.id) continue;

      // Skip pinned nodes - user has positioned them manually
      if (node.pinned) continue;

      let fx = 0;
      let fy = 0;

      // Repulsion from all nodes
      for (let j = 0; j < graphNodes.length; j++) {
        if (i === j) continue;
        const other = graphNodes[j];
        let dx = node.x - other.x;
        let dy = node.y - other.y;

        if (dx === 0 && dy === 0) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
        }

        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq);

        const isConnected = physicsAdjacency.get(node.id)?.has(other.id);
        const repulsionStrength = isConnected ? 2000 : 4000;
        const minDistSq = 400;
        const effectiveDistSq = Math.max(distSq, minDistSq);
        const repulsion = repulsionStrength / effectiveDistSq;
        fx += (dx / dist) * repulsion;
        fy += (dy / dist) * repulsion;

        // Collision
        const minDist = node.radius + other.radius + 15;
        if (dist < minDist && dist > 0) {
          const overlap = minDist - dist;
          const pushX = (dx / dist) * overlap * 0.3;
          const pushY = (dy / dist) * overlap * 0.3;
          node.x += pushX;
          node.y += pushY;
          if (!currentDraggedNode || other.id !== currentDraggedNode.id) {
            other.x -= pushX;
            other.y -= pushY;
          }
        }
      }

      // Attraction along edges
      const neighbors = physicsAdjacency.get(node.id);
      if (neighbors) {
        for (const otherId of neighbors) {
          const other = physicsNodeMap.get(otherId);
          if (!other) continue;

          let dx = other.x - node.x;
          let dy = other.y - node.y;

          if (dx === 0 && dy === 0) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
          }

          const dist = Math.sqrt(dx * dx + dy * dy);
          const targetDist = node.radius + other.radius + 80;
          // Stronger force when connected to dragged node (makes neighbors follow)
          const isDraggedNeighbor = currentDraggedNode && other.id === currentDraggedNode.id;
          const forceMultiplier = isDraggedNeighbor ? 0.15 : 0.05;
          const force = (dist - targetDist) * forceMultiplier;
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
      }

      // Center gravity (stronger for small windows to keep nodes in view)
      const gravityStrength = isSmallWindow ? 0.003 : 0.001;
      fx += (centerX - node.x) * gravityStrength;
      fy += (centerY - node.y) * gravityStrength;

      // Very weak center attraction instead of hard boundaries
      // This keeps nodes somewhat centered but allows them to spread naturally
      const centerAttractionStrength = 0.001;
      fx += (centerX - node.x) * centerAttractionStrength;
      fy += (centerY - node.y) * centerAttractionStrength;

      // Apply velocity with damping
      node.vx = (node.vx + fx * alpha * 0.3) * damping;
      node.vy = (node.vy + fy * alpha * 0.3) * damping;

      // Clamp velocity to prevent chaos
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > maxVelocity) {
        node.vx = (node.vx / speed) * maxVelocity;
        node.vy = (node.vy / speed) * maxVelocity;
      }

      node.x += node.vx;
      node.y += node.vy;
      // No hard boundaries - use pan/zoom to navigate
    }

    setNodes([...graphNodes]);
    render();

    physicsFrame = requestAnimationFrame(runLivePhysics);
  };

  // Start/stop live physics based on signal
  createEffect(() => {
    if (livePhysics()) {
      // Clear cached data when starting
      physicsAdjacency = null;
      physicsNodeMap = null;
      if (!physicsFrame) {
        physicsFrame = requestAnimationFrame(runLivePhysics);
      }
    } else {
      if (physicsFrame) {
        cancelAnimationFrame(physicsFrame);
        physicsFrame = null;
      }
    }
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

    if (node && node.pinned) {
      // Double-click on pinned node unpins it
      const nodesCopy = [...nodes()];
      const idx = nodesCopy.findIndex(n => n.id === node.id);
      if (idx >= 0) {
        nodesCopy[idx] = { ...nodesCopy[idx], pinned: false };
        setNodes(nodesCopy);
        render();
      }
    }
  };

  const unpinAllNodes = () => {
    const nodesCopy = nodes().map(n => ({ ...n, pinned: false }));
    setNodes(nodesCopy);
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
      console.error("Failed to analyze removal:", e);
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
    if (physicsFrame) {
      cancelAnimationFrame(physicsFrame);
      physicsFrame = null;
    }

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
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.libs || "Libs"}
          </label>

          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
            <input
              type="checkbox"
              checked={showDisabled()}
              onChange={(e) => setShowDisabled(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.disabled || "Off"}
          </label>

          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50">
            <input
              type="checkbox"
              checked={highlightProblems()}
              onChange={(e) => setHighlightProblems(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.issues || "Issues"}
          </label>

          <label class="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none px-1.5 py-1 rounded hover:bg-gray-700/50" title="Show mods without any dependencies">
            <input
              type="checkbox"
              checked={showOrphans()}
              onChange={(e) => setShowOrphans(e.currentTarget.checked)}
              class="w-3 h-3 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-0"
            />
            {t().mods?.dependencyGraph?.filters?.solo || "Solo"}
          </label>

          <div class="w-px h-4 bg-gray-700 mx-0.5" />

          <button
            onClick={() => setLivePhysics(!livePhysics())}
            class={`p-2 flex items-center justify-center rounded-full transition-colors ${
              livePhysics()
                ? "text-green-400 bg-green-500/20 hover:bg-green-500/30"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
            title={livePhysics() ? "Остановить физику" : "Включить физику (реальное время)"}
          >
            <i class={livePhysics() ? "i-hugeicons-stop w-3 h-3" : "i-hugeicons-play w-3 h-3"} />
          </button>

          <Show when={hasPinnedNodes()}>
            <button
              onClick={unpinAllNodes}
              class="p-2 flex items-center justify-center text-yellow-400 hover:text-yellow-300 hover:bg-yellow-500/20 rounded-full transition-colors"
              title="Открепить все узлы (двойной клик на узел = открепить)"
            >
              <i class="i-hugeicons-pin-off w-3 h-3" />
            </button>
          </Show>

          <button
            onClick={openSearch}
            class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            title={t().mods?.dependencyGraph?.tooltips?.search || "Search (Ctrl+F)"}
          >
            <i class="i-hugeicons-search-01 w-3 h-3" />
          </button>

          <button
            onClick={fitToScreen}
            class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            title={t().mods?.dependencyGraph?.tooltips?.fitToScreen || "Fit to screen"}
          >
            <i class="i-hugeicons-arrow-expand-02 w-3 h-3" />
          </button>

          <button
            onClick={resetView}
            class="p-2 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors"
            title={t().mods?.dependencyGraph?.tooltips?.resetView || "Reset view"}
          >
            <i class="i-hugeicons-home-01 w-3 h-3" />
          </button>

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
        <div ref={containerRef} class="flex-1 relative overflow-hidden">
          <Show when={loading()}>
            <div class="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/95 z-20">
              <i class="i-svg-spinners-ring-resize w-10 h-10 text-blue-500 mb-3" />
              <Show when={simulationProgress() > 0}>
                <div class="text-sm text-gray-400 mb-2">
                  {t().mods?.dependencyGraph?.calculatingLayout || "Calculating layout..."} {simulationProgress()}%
                </div>
                <div class="w-48 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-blue-500 transition-all duration-150"
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
              <div class="text-center max-w-md px-4">
                <i class="i-hugeicons-alert-02 w-12 h-12 text-red-400 mb-4" />
                <p class="text-red-400 text-sm mb-4">{error()}</p>
                <button
                  onClick={() => loadGraph()}
                  class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
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
                      <button
                        onClick={prevSearchResult}
                        class="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700/50"
                        title={t().mods?.dependencyGraph?.search?.prev || "Previous (Shift+Enter)"}
                      >
                        <i class="i-hugeicons-arrow-up-01 w-3 h-3" />
                      </button>
                      <button
                        onClick={nextSearchResult}
                        class="p-1 text-gray-400 hover:text-white rounded hover:bg-gray-700/50"
                        title={t().mods?.dependencyGraph?.search?.next || "Next (Enter)"}
                      >
                        <i class="i-hugeicons-arrow-down-01 w-3 h-3" />
                      </button>
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

        {/* Selected node panel - uses memoized data to avoid infinite render loops */}
        {/* keyed forces re-render when selected node changes */}
        <Show when={selectedPanelData()} keyed>
          {(data) => {
            // With keyed=true, 'data' is the actual value (not accessor),
            // and this block re-runs when selectedPanelData changes identity
            const sel = data.sel;
            const uniqueDependsOnMods = data.uniqueDependsOnMods;
            const uniqueIncompatibleMods = data.uniqueIncompatibleMods;
            const uniqueDependentMods = data.uniqueDependentMods;
            const tg = () => t().mods?.dependencyGraph;

            return (
              <div class="flex-shrink-0 w-72 bg-gray-850 border-l border-gray-700 p-4 overflow-y-auto">
                <div class="flex items-start gap-3 mb-4">
                  <Show
                    when={sel.icon_url}
                    fallback={
                      <div class="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
                        <i class="i-hugeicons-package w-6 h-6 text-gray-500" />
                      </div>
                    }
                  >
                    <img
                      src={sel.icon_url!}
                      alt=""
                      class="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                    />
                  </Show>
                  <div class="min-w-0 flex-1">
                    <h3 class="font-medium text-white text-sm leading-tight mb-1">
                      {sel.name}
                    </h3>
                    <p class="text-xs text-gray-400 truncate">{sel.version}</p>
                  </div>
                </div>

                <div class="space-y-3 text-sm">
                  <div class="flex justify-between items-center py-2 border-b border-gray-700/50">
                    <span class="text-gray-400">{tg()?.panel?.source || "Source"}</span>
                    <span class="text-white capitalize font-medium">{sel.source}</span>
                  </div>
                  <div class="flex justify-between items-center py-2 border-b border-gray-700/50">
                    <span class="text-gray-400">{tg()?.panel?.status || "Status"}</span>
                    <span class={`font-medium ${sel.enabled ? "text-green-400" : "text-gray-500"}`}>
                      {sel.enabled
                        ? (tg()?.panel?.enabled || "Enabled")
                        : (tg()?.panel?.disabled || "Disabled")}
                    </span>
                  </div>

                  <Show when={sel.is_library}>
                    <div class="flex items-center gap-2 px-3 py-2 bg-indigo-500/20 rounded-lg text-indigo-300">
                      <i class="i-hugeicons-libraries w-4 h-4" />
                      <span class="text-sm font-medium">{tg()?.panel?.library || "Library Mod"}</span>
                    </div>
                  </Show>

                  {/* Dependencies section */}
                  <div class="pt-2">
                    <div class="flex items-center gap-2 mb-2">
                      <i class="i-hugeicons-arrow-down-01 w-4 h-4 text-blue-400" />
                      <span class="text-gray-300 font-medium text-xs uppercase tracking-wide">
                        {tg()?.panel?.dependsOn || "Depends on"} ({uniqueDependsOnMods.length})
                      </span>
                    </div>
                    <Show
                      when={uniqueDependsOnMods.length > 0}
                      fallback={
                        <p class="text-xs text-gray-500 italic pl-6">
                          {tg()?.panel?.noDependencies || "No dependencies"}
                        </p>
                      }
                    >
                      <div class="space-y-1 max-h-32 overflow-y-auto">
                        <For each={uniqueDependsOnMods}>
                          {(dep) => (
                            <button
                              class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group"
                              classList={{
                                "hover:bg-gray-700/50 cursor-pointer": !!dep.node,
                                "cursor-default opacity-60": !dep.node,
                              }}
                              onClick={() => dep.node && focusOnNode(dep.node)}
                              disabled={!dep.node}
                              title={dep.node ? tg()?.panel?.clickToFocus || "Click to focus" : tg()?.panel?.notInstalled || "Not installed"}
                            >
                              <Show
                                when={dep.node?.icon_url}
                                fallback={
                                  <div
                                    class="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center"
                                    classList={{
                                      "bg-red-500/30": !dep.node || dep.type === "required",
                                      "bg-yellow-500/30": dep.node && dep.type === "optional",
                                      "bg-gray-600": dep.node && dep.type !== "required" && dep.type !== "optional",
                                    }}
                                  >
                                    <i
                                      class="w-3 h-3"
                                      classList={{
                                        "i-hugeicons-alert-02 text-red-400": !dep.node,
                                        "i-hugeicons-package text-gray-400": !!dep.node,
                                      }}
                                    />
                                  </div>
                                }
                              >
                                <img
                                  src={dep.node!.icon_url!}
                                  alt=""
                                  class="w-5 h-5 rounded flex-shrink-0 object-cover"
                                />
                              </Show>
                              <span
                                class="text-xs truncate flex-1"
                                classList={{
                                  "text-gray-300 group-hover:text-white": !!dep.node,
                                  "text-gray-500 line-through": !dep.node,
                                }}
                              >
                                {dep.name}
                              </span>
                              <Show when={!dep.node}>
                                <span class="text-[10px] text-red-400" title={tg()?.panel?.missingDependency || "Missing dependency"}>
                                  {tg()?.panel?.missing || "missing"}
                                </span>
                              </Show>
                              <Show when={dep.node && dep.type === "optional"}>
                                <span class="text-[10px] text-gray-500">(opt)</span>
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  {/* Incompatible section */}
                  <Show when={uniqueIncompatibleMods.length > 0}>
                    <div class="pt-2">
                      <div class="flex items-center gap-2 mb-2">
                        <i class="i-hugeicons-alert-02 w-4 h-4 text-red-400" />
                        <span class="text-gray-300 font-medium text-xs uppercase tracking-wide">
                          {tg()?.panel?.incompatibleWith || "Incompatible with"} ({uniqueIncompatibleMods.length})
                        </span>
                      </div>
                      <div class="space-y-1 max-h-32 overflow-y-auto">
                        <For each={uniqueIncompatibleMods}>
                          {(mod) => (
                            <button
                              class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group"
                              classList={{
                                "hover:bg-gray-700/50 cursor-pointer": !!mod.node,
                                "cursor-default opacity-60": !mod.node,
                              }}
                              onClick={() => mod.node && focusOnNode(mod.node)}
                              disabled={!mod.node}
                              title={mod.node ? tg()?.panel?.clickToFocus || "Click to focus" : tg()?.panel?.notInstalled || "Not installed"}
                            >
                              <Show
                                when={mod.node?.icon_url}
                                fallback={
                                  <div class="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center bg-red-500/30">
                                    <i class="i-hugeicons-package w-3 h-3 text-red-400" />
                                  </div>
                                }
                              >
                                <img
                                  src={mod.node!.icon_url!}
                                  alt=""
                                  class="w-5 h-5 rounded flex-shrink-0 object-cover ring-1 ring-red-500/50"
                                />
                              </Show>
                              <span
                                class="text-xs truncate flex-1"
                                classList={{
                                  "text-gray-300 group-hover:text-white": !!mod.node,
                                  "text-gray-500": !mod.node,
                                }}
                              >
                                {mod.name}
                              </span>
                              <Show when={mod.is_problem}>
                                <i class="i-hugeicons-alert-02 w-3 h-3 text-red-400" title={tg()?.panel?.installedConflict || "Installed - conflict!"} />
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Dependents section */}
                  <div class="pt-2">
                    <div class="flex items-center gap-2 mb-2">
                      <i class="i-hugeicons-arrow-up-01 w-4 h-4 text-green-400" />
                      <span class="text-gray-300 font-medium text-xs uppercase tracking-wide">
                        {tg()?.panel?.requiredBy || "Required by"} ({uniqueDependentMods.length})
                      </span>
                    </div>
                    <Show
                      when={uniqueDependentMods.length > 0}
                      fallback={
                        <p class="text-xs text-gray-500 italic pl-6">
                          {tg()?.panel?.noDependents || "No dependents"}
                        </p>
                      }
                    >
                      <div class="space-y-1 max-h-32 overflow-y-auto">
                        <For each={uniqueDependentMods}>
                          {(dep) => (
                            <button
                              class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group"
                              classList={{
                                "hover:bg-gray-700/50 cursor-pointer": !!dep.node,
                                "cursor-default opacity-60": !dep.node,
                              }}
                              onClick={() => dep.node && focusOnNode(dep.node)}
                              disabled={!dep.node}
                              title={dep.node ? tg()?.panel?.clickToFocus || "Click to focus" : undefined}
                            >
                              <Show
                                when={dep.node?.icon_url}
                                fallback={
                                  <div
                                    class="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center"
                                    classList={{
                                      "bg-green-500/30": dep.type === "required",
                                      "bg-yellow-500/30": dep.type === "optional",
                                      "bg-gray-600": dep.type !== "required" && dep.type !== "optional",
                                    }}
                                  >
                                    <i class="i-hugeicons-package w-3 h-3 text-gray-400" />
                                  </div>
                                }
                              >
                                <img
                                  src={dep.node!.icon_url!}
                                  alt=""
                                  class="w-5 h-5 rounded flex-shrink-0 object-cover"
                                />
                              </Show>
                              <span
                                class="text-xs truncate flex-1"
                                classList={{
                                  "text-gray-300 group-hover:text-white": !!dep.node,
                                  "text-gray-500": !dep.node,
                                }}
                              >
                                {dep.name}
                              </span>
                              <Show when={dep.type === "optional"}>
                                <span class="text-[10px] text-gray-500">(opt)</span>
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>

                <button
                  onClick={analyzeRemoval}
                  class="w-full mt-4 px-3 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm flex items-center justify-center gap-2 transition-colors"
                >
                  <i class="i-hugeicons-delete-02 w-4 h-4" />
                  {tg()?.panel?.analyzeRemoval || "Analyze Removal"}
                </button>
              </div>
            );
          }}
        </Show>
      </div>

      {/* Removal analysis dialog */}
      <Show when={showRemovalDialog() && removalAnalysis()}>
        <ModalWrapper backdrop onBackdropClick={() => setShowRemovalDialog(false)}>
          <div class="w-[480px] bg-gray-850 rounded-xl overflow-hidden">
            <div class="flex items-center gap-3 px-5 py-4 border-b border-gray-700">
              <i
                class={`w-6 h-6 ${
                  removalAnalysis()!.is_safe
                    ? "i-hugeicons-checkmark-circle-02 text-green-400"
                    : "i-hugeicons-alert-02 text-yellow-400"
                }`}
              />
              <h3 class="text-lg font-medium text-white">
                {t().mods?.dependencyGraph?.removal?.title || "Removal Analysis"}
              </h3>
            </div>

            <div class="p-5">
              <p class="text-sm text-gray-300 mb-4">
                {removalAnalysis()!.is_safe
                  ? (t().mods?.dependencyGraph?.removal?.safe || "This mod can be safely removed without breaking other mods.")
                  : (t().mods?.dependencyGraph?.removal?.unsafe || "Removing this mod may cause issues with other mods.")}
              </p>

              <Show when={removalAnalysis()!.affected_mods.length > 0}>
                <div class="mb-4">
                  <h4 class="text-sm font-medium text-red-400 mb-2 flex items-center gap-2">
                    <i class="i-hugeicons-alert-02 w-4 h-4" />
                    {t().mods?.dependencyGraph?.removal?.willBreak || "Will Break"} ({removalAnalysis()!.affected_mods.length} {t().mods?.dependencyGraph?.removal?.modsCount || "mods"})
                  </h4>
                  <div class="space-y-2 max-h-40 overflow-y-auto">
                    <For each={removalAnalysis()!.affected_mods}>
                      {(mod) => (
                        <div class="p-3 bg-red-500/10 rounded-lg border border-red-500/20">
                          <div class="font-medium text-white text-sm">{mod.name}</div>
                          <div class="text-xs text-gray-400 mt-0.5">{mod.reason}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={removalAnalysis()!.warning_mods.length > 0}>
                <div>
                  <h4 class="text-sm font-medium text-yellow-400 mb-2 flex items-center gap-2">
                    <i class="i-hugeicons-alert-02 w-4 h-4" />
                    {t().mods?.dependencyGraph?.removal?.mayHaveIssues || "May Have Issues"} ({removalAnalysis()!.warning_mods.length} {t().mods?.dependencyGraph?.removal?.modsCount || "mods"})
                  </h4>
                  <div class="space-y-2 max-h-40 overflow-y-auto">
                    <For each={removalAnalysis()!.warning_mods}>
                      {(mod) => (
                        <div class="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
                          <div class="font-medium text-white text-sm">{mod.name}</div>
                          <div class="text-xs text-gray-400 mt-0.5">{mod.reason}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>

            <div class="flex justify-end px-5 py-4 border-t border-gray-700 bg-gray-800/50">
              <button
                onClick={() => setShowRemovalDialog(false)}
                class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              >
                {t().mods?.dependencyGraph?.removal?.close || "Close"}
              </button>
            </div>
          </div>
        </ModalWrapper>
      </Show>
    </div>
  );
}
