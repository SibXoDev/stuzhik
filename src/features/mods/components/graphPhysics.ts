// Force-directed graph physics for DependencyGraph
import type { DependencyEdge, DependencyNode, GraphNode } from "./graphTypes";

interface CanvasDimensions {
  width: number;
  height: number;
  dpr: number;
}

interface SimulationCallbacks {
  setNodes: (nodes: GraphNode[]) => void;
  setSimulationProgress: (progress: number) => void;
  setLoading: (loading: boolean) => void;
  render: () => void;
  fitToScreen: () => void;
}

// Calculate radius based on node importance
const getRadius = (node: DependencyNode): number => {
  if (node.is_library || node.dependent_count > 5) return 28;
  if (node.dependent_count > 2) return 22;
  return 18;
};

// Create GraphNode[] from raw data with initial spiral positions
export function createGraphNodes(
  data: { nodes: DependencyNode[] },
  canvas: CanvasDimensions,
): GraphNode[] {
  const width = canvas.width / canvas.dpr;
  const height = canvas.height / canvas.dpr;
  const centerX = width / 2;
  const centerY = height / 2;

  return data.nodes.map((node, i) => {
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
}

// Run initial force simulation (chunked, async via requestAnimationFrame)
export function runForceSimulation(
  graphNodes: GraphNode[],
  edges: DependencyEdge[],
  canvas: CanvasDimensions,
  callbacks: SimulationCallbacks,
) {
  const width = canvas.width / canvas.dpr;
  const height = canvas.height / canvas.dpr;
  const centerX = width / 2;
  const centerY = height / 2;

  if (width === 0 || height === 0) return;

  // Build adjacency maps
  const dependsOn = new Map<string, Set<string>>();
  const dependedBy = new Map<string, Set<string>>();
  const nodeMap = new Map<string, GraphNode>();

  for (const node of graphNodes) {
    nodeMap.set(node.id, node);
    dependsOn.set(node.id, new Set());
    dependedBy.set(node.id, new Set());
  }

  for (const edge of edges) {
    if (edge.dependency_type === "required" || edge.dependency_type === "optional") {
      dependsOn.get(edge.from)?.add(edge.to);
      dependedBy.get(edge.to)?.add(edge.from);
    }
  }

  // Compute dependency levels (topological sort)
  const levels = new Map<string, number>();
  const computeLevel = (nodeId: string, visited: Set<string>): number => {
    if (levels.has(nodeId)) return levels.get(nodeId)!;
    if (visited.has(nodeId)) return 0;
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

  // Initial placement: by level in concentric rings
  const maxRadius = Math.min(width, height) * 0.45;

  for (let level = 0; level <= maxLevel; level++) {
    const nodesAtLevel = nodesByLevel[level];
    if (nodesAtLevel.length === 0) continue;

    const ringRadius = level === 0
      ? Math.min(width, height) * 0.1
      : (level / (maxLevel || 1)) * maxRadius;

    nodesAtLevel.sort((a, b) => {
      const aDeps = Array.from(dependsOn.get(a.id) || []);
      const bDeps = Array.from(dependsOn.get(b.id) || []);
      return (aDeps[0] || "").localeCompare(bDeps[0] || "");
    });

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

  // Scale iterations based on node count
  const TOTAL_ITERATIONS = graphNodes.length > 300 ? 150 : 250;
  const ITERATIONS_PER_CHUNK = graphNodes.length > 300 ? 10 : 5;
  let currentIteration = 0;

  const runChunk = () => {
    const endIteration = Math.min(currentIteration + ITERATIONS_PER_CHUNK, TOTAL_ITERATIONS);
    const alpha = Math.pow(1 - currentIteration / TOTAL_ITERATIONS, 2);

    for (let iter = currentIteration; iter < endIteration; iter++) {
      for (let i = 0; i < graphNodes.length; i++) {
        const node = graphNodes[i];
        let fx = 0;
        let fy = 0;

        // Repulsion from nearby nodes (with distance cutoff)
        const INIT_REPULSION_CUTOFF_SQ = 500000;
        for (let j = 0; j < graphNodes.length; j++) {
          if (i === j) continue;
          const other = graphNodes[j];
          let dx = node.x - other.x;
          let dy = node.y - other.y;

          const distSq = dx * dx + dy * dy;
          if (distSq > INIT_REPULSION_CUTOFF_SQ) continue;

          if (dx === 0 && dy === 0) {
            dx = (Math.random() - 0.5) * 2;
            dy = (Math.random() - 0.5) * 2;
          }

          const dist = Math.sqrt(distSq);
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

        // STRONG attraction along edges
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
            const targetDist = node.radius + other.radius + 80;
            const force = (dist - targetDist) * 0.08;
            fx += (dx / dist) * force;
            fy += (dy / dist) * force;
          }
        }

        // Weak center gravity
        fx += (centerX - node.x) * 0.001;
        fy += (centerY - node.y) * 0.001;

        // Apply velocity with strong damping
        node.vx = (node.vx + fx * alpha * 0.4) * 0.8;
        node.vy = (node.vy + fy * alpha * 0.4) * 0.8;

        // Velocity cap
        const maxVelocity = 20;
        const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
        if (speed > maxVelocity) {
          node.vx = (node.vx / speed) * maxVelocity;
          node.vy = (node.vy / speed) * maxVelocity;
        }

        node.x += node.vx;
        node.y += node.vy;

        // NaN check
        if (!isFinite(node.x) || !isFinite(node.y)) {
          node.x = centerX + (Math.random() - 0.5) * 100;
          node.y = centerY + (Math.random() - 0.5) * 100;
          node.vx = 0;
          node.vy = 0;
        }

        // Soft safety clamp
        const safetyMargin = node.radius;
        node.x = Math.max(safetyMargin, Math.min(width - safetyMargin, node.x));
        node.y = Math.max(safetyMargin, Math.min(height - safetyMargin, node.y));
      }
    }

    currentIteration = endIteration;
    callbacks.setSimulationProgress(Math.round((currentIteration / TOTAL_ITERATIONS) * 100));
    callbacks.setNodes([...graphNodes]);
    callbacks.render();

    if (currentIteration < TOTAL_ITERATIONS) {
      requestAnimationFrame(runChunk);
    } else {
      callbacks.setLoading(false);
      callbacks.fitToScreen();
    }
  };

  runChunk();
}

// Live physics engine — runs continuously when enabled
export interface LivePhysicsParams {
  getNodes: () => GraphNode[];
  getGraph: () => { edges: DependencyEdge[] } | null;
  getCanvas: () => CanvasDimensions | null;
  getFilters: () => { showOrphans: boolean; showLibraries: boolean; showDisabled: boolean };
  getDraggedNode: () => GraphNode | null;
  setNodes: (nodes: GraphNode[]) => void;
  render: () => void;
}

export interface LivePhysicsController {
  start: () => void;
  stop: () => void;
  resetStability: () => void;
  invalidateActiveNodes: () => void;
  destroy: () => void;
}

export function createLivePhysics(params: LivePhysicsParams): LivePhysicsController {
  let physicsFrame: number | null = null;
  let adjacency: Map<string, Set<string>> | null = null;
  let nodeMap: Map<string, GraphNode> | null = null;
  let activeNodes: GraphNode[] | null = null;
  let stableFrames = 0;
  let frameCount = 0;
  let running = false;

  const runStep = () => {
    if (!running) {
      physicsFrame = null;
      return;
    }

    const canvas = params.getCanvas();
    if (!canvas || canvas.width === 0) {
      physicsFrame = null;
      return;
    }

    const graphNodes = params.getNodes();
    const graphData = params.getGraph();
    if (!graphData || graphNodes.length === 0) {
      physicsFrame = requestAnimationFrame(runStep);
      return;
    }

    // Build adjacency (cached)
    if (!adjacency) {
      adjacency = new Map<string, Set<string>>();
      for (const edge of graphData.edges) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
        adjacency.get(edge.from)!.add(edge.to);
        adjacency.get(edge.to)!.add(edge.from);
      }
    }

    // Rebuild node map every frame
    nodeMap = new Map<string, GraphNode>();
    for (const node of graphNodes) {
      nodeMap.set(node.id, node);
    }

    // Filter active nodes (cached)
    if (!activeNodes) {
      const filters = params.getFilters();
      activeNodes = graphNodes.filter(n => {
        if (!filters.showLibraries && n.is_library) return false;
        if (!filters.showDisabled && !n.enabled) return false;
        if (!filters.showOrphans && n.dependency_count === 0 && n.dependent_count === 0) return false;
        return true;
      });
    }

    if (activeNodes.length === 0) {
      params.render();
      physicsFrame = requestAnimationFrame(runStep);
      return;
    }

    const width = canvas.width / canvas.dpr;
    const height = canvas.height / canvas.dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    const currentDraggedNode = params.getDraggedNode();
    const minDimension = Math.min(width, height);
    const isSmallWindow = minDimension < 400;
    const alpha = isSmallWindow ? 0.15 : 0.3;
    const damping = isSmallWindow ? 0.7 : 0.85;
    const maxVelocity = isSmallWindow ? 5 : 15;
    const REPULSION_CUTOFF_SQ = 400000;

    let totalKineticEnergy = 0;

    for (let i = 0; i < activeNodes.length; i++) {
      const node = activeNodes[i];

      if (currentDraggedNode && node.id === currentDraggedNode.id) continue;
      if (node.pinned) continue;

      let fx = 0;
      let fy = 0;

      // Repulsion
      for (let j = 0; j < activeNodes.length; j++) {
        if (i === j) continue;
        const other = activeNodes[j];
        let dx = node.x - other.x;
        let dy = node.y - other.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > REPULSION_CUTOFF_SQ) continue;

        if (dx === 0 && dy === 0) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
        }

        const dist = Math.sqrt(distSq);
        const isConnected = adjacency.get(node.id)?.has(other.id);
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
          const targetDist = node.radius + other.radius + 80;
          const isDraggedNeighbor = currentDraggedNode && other.id === currentDraggedNode.id;
          const forceMultiplier = isDraggedNeighbor ? 0.15 : 0.05;
          const force = (dist - targetDist) * forceMultiplier;
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }
      }

      // Center gravity
      const gravityStrength = isSmallWindow ? 0.004 : 0.002;
      fx += (centerX - node.x) * gravityStrength;
      fy += (centerY - node.y) * gravityStrength;

      // Apply velocity
      node.vx = (node.vx + fx * alpha * 0.3) * damping;
      node.vy = (node.vy + fy * alpha * 0.3) * damping;

      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > maxVelocity) {
        node.vx = (node.vx / speed) * maxVelocity;
        node.vy = (node.vy / speed) * maxVelocity;
      }

      node.x += node.vx;
      node.y += node.vy;

      totalKineticEnergy += node.vx * node.vx + node.vy * node.vy;
    }

    // Auto-stop detection
    const STABILITY_THRESHOLD = 0.1;
    const STABLE_FRAMES_NEEDED = 30;
    if (totalKineticEnergy < STABILITY_THRESHOLD && !currentDraggedNode) {
      stableFrames++;
      if (stableFrames >= STABLE_FRAMES_NEEDED) {
        params.setNodes([...graphNodes]);
        params.render();
        physicsFrame = requestAnimationFrame(runStep);
        return;
      }
    } else {
      stableFrames = 0;
    }

    // Throttle setNodes: every 10 frames
    frameCount++;
    if (frameCount % 10 === 0) {
      params.setNodes([...graphNodes]);
    }
    params.render();

    physicsFrame = requestAnimationFrame(runStep);
  };

  return {
    start() {
      adjacency = null;
      nodeMap = null;
      activeNodes = null;
      stableFrames = 0;
      frameCount = 0;
      running = true;
      if (!physicsFrame) {
        physicsFrame = requestAnimationFrame(runStep);
      }
    },
    stop() {
      running = false;
      if (physicsFrame) {
        cancelAnimationFrame(physicsFrame);
        physicsFrame = null;
      }
    },
    resetStability() {
      stableFrames = 0;
    },
    invalidateActiveNodes() {
      activeNodes = null;
      stableFrames = 0;
    },
    destroy() {
      running = false;
      if (physicsFrame) {
        cancelAnimationFrame(physicsFrame);
        physicsFrame = null;
      }
    },
  };
}
