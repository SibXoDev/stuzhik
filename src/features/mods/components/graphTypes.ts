// Types for DependencyGraph component

export interface DependencyNode {
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

export interface DependencyEdge {
  from: string;
  from_name?: string;
  to: string;
  to_name: string;
  dependency_type: string;
  version_requirement: string | null;
  is_satisfied: boolean;
  is_problem: boolean;
}

export interface DependencyGraphData {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface ModRemovalAnalysis {
  mod_slug: string;
  is_safe: boolean;
  affected_mods: AffectedMod[];
  warning_mods: AffectedMod[];
  total_affected: number;
  recommendation: string;
}

export interface AffectedMod {
  slug: string;
  name: string;
  impact: string;
  reason: string;
}

// Internal node with position for rendering
export interface GraphNode extends DependencyNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinned: boolean;
}
