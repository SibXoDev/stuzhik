import { Show, For } from "solid-js";
import type { Accessor } from "solid-js";
import type { GraphNode } from "./graphTypes";
import { Tooltip } from "../../../shared/ui";

interface DepInfo {
  name: string;
  type: string;
  node: GraphNode | undefined;
  is_problem: boolean;
}

interface IncompatInfo {
  name: string;
  node: GraphNode | undefined;
  is_problem: boolean;
}

interface DependentInfo {
  name: string;
  type: string;
  node: GraphNode | undefined;
}

export interface PanelData {
  sel: GraphNode;
  uniqueDependsOnMods: DepInfo[];
  uniqueIncompatibleMods: IncompatInfo[];
  uniqueDependentMods: DependentInfo[];
}

interface Props {
  data: PanelData;
  onFocusNode: (node: GraphNode) => void;
  onAnalyzeRemoval: () => void;
  t: Accessor<Record<string, any>>;
}

export default function GraphNodePanel(props: Props) {
  const tg = () => props.t().mods?.dependencyGraph;
  const sel = () => props.data.sel;

  return (
    <div class="flex-shrink-0 w-72 bg-gray-850 border-l border-gray-700 p-4 overflow-y-auto">
      <div class="flex items-start gap-3 mb-4">
        <Show
          when={sel().icon_url}
          fallback={
            <div class="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
              <i class="i-hugeicons-package w-6 h-6 text-gray-500" />
            </div>
          }
        >
          <img
            src={sel().icon_url!}
            alt=""
            class="w-12 h-12 rounded-lg object-cover flex-shrink-0"
          />
        </Show>
        <div class="min-w-0 flex-1">
          <h3 class="font-medium text-white text-sm leading-tight mb-1">
            {sel().name}
          </h3>
          <p class="text-xs text-gray-400 truncate">{sel().version}</p>
        </div>
      </div>

      <div class="space-y-3 text-sm">
        <div class="flex justify-between items-center py-2 border-b border-gray-700/50">
          <span class="text-gray-400">{tg()?.panel?.source || "Source"}</span>
          <span class="text-white capitalize font-medium">{sel().source}</span>
        </div>
        <div class="flex justify-between items-center py-2 border-b border-gray-700/50">
          <span class="text-gray-400">{tg()?.panel?.status || "Status"}</span>
          <span class={`font-medium ${sel().enabled ? "text-green-400" : "text-gray-500"}`}>
            {sel().enabled
              ? (tg()?.panel?.enabled || "Enabled")
              : (tg()?.panel?.disabled || "Disabled")}
          </span>
        </div>

        <Show when={sel().is_library}>
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
              {tg()?.panel?.dependsOn || "Depends on"} ({props.data.uniqueDependsOnMods.length})
            </span>
          </div>
          <Show
            when={props.data.uniqueDependsOnMods.length > 0}
            fallback={
              <p class="text-xs text-gray-500 italic pl-6">
                {tg()?.panel?.noDependencies || "No dependencies"}
              </p>
            }
          >
            <div class="space-y-1 max-h-32 overflow-y-auto">
              <For each={props.data.uniqueDependsOnMods}>
                {(dep) => (
                  <Tooltip text={dep.node ? tg()?.panel?.clickToFocus || "Click to focus" : tg()?.panel?.notInstalled || "Not installed"} position="bottom">
                    <button
                      class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group"
                      classList={{
                        "hover:bg-gray-700/50 cursor-pointer": !!dep.node,
                        "cursor-default opacity-60": !dep.node,
                      }}
                      onClick={() => dep.node && props.onFocusNode(dep.node)}
                      disabled={!dep.node}
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
                        <Tooltip text={tg()?.panel?.missingDependency || "Missing dependency"} position="bottom">
                          <span class="text-[10px] text-red-400">
                            {tg()?.panel?.missing || "missing"}
                          </span>
                        </Tooltip>
                      </Show>
                      <Show when={dep.node && dep.type === "optional"}>
                        <span class="text-[10px] text-gray-500">(opt)</span>
                      </Show>
                    </button>
                  </Tooltip>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Incompatible section */}
        <Show when={props.data.uniqueIncompatibleMods.length > 0}>
          <div class="pt-2">
            <div class="flex items-center gap-2 mb-2">
              <i class="i-hugeicons-alert-02 w-4 h-4 text-red-400" />
              <span class="text-gray-300 font-medium text-xs uppercase tracking-wide">
                {tg()?.panel?.incompatibleWith || "Incompatible with"} ({props.data.uniqueIncompatibleMods.length})
              </span>
            </div>
            <div class="space-y-1 max-h-32 overflow-y-auto">
              <For each={props.data.uniqueIncompatibleMods}>
                {(mod) => (
                  <Tooltip text={mod.node ? tg()?.panel?.clickToFocus || "Click to focus" : tg()?.panel?.notInstalled || "Not installed"} position="bottom">
                    <button
                      class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group"
                      classList={{
                        "hover:bg-gray-700/50 cursor-pointer": !!mod.node,
                        "cursor-default opacity-60": !mod.node,
                      }}
                      onClick={() => mod.node && props.onFocusNode(mod.node)}
                      disabled={!mod.node}
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
                        <Tooltip text={tg()?.panel?.installedConflict || "Installed - conflict!"} position="bottom">
                          <i class="i-hugeicons-alert-02 w-3 h-3 text-red-400" />
                        </Tooltip>
                      </Show>
                    </button>
                  </Tooltip>
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
              {tg()?.panel?.requiredBy || "Required by"} ({props.data.uniqueDependentMods.length})
            </span>
          </div>
          <Show
            when={props.data.uniqueDependentMods.length > 0}
            fallback={
              <p class="text-xs text-gray-500 italic pl-6">
                {tg()?.panel?.noDependents || "No dependents"}
              </p>
            }
          >
            <div class="space-y-1 max-h-32 overflow-y-auto">
              <For each={props.data.uniqueDependentMods}>
                {(dep) => (
                  <Show when={dep.node} fallback={
                    <button
                      class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group cursor-default opacity-60"
                      disabled
                    >
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
                      <span class="text-xs truncate flex-1 text-gray-500">
                        {dep.name}
                      </span>
                      <Show when={dep.type === "optional"}>
                        <span class="text-[10px] text-gray-500">(opt)</span>
                      </Show>
                    </button>
                  }>
                    <Tooltip text={tg()?.panel?.clickToFocus || "Click to focus"} position="bottom">
                      <button
                        class="w-full text-left px-2 py-1.5 rounded transition-colors flex items-center gap-2 group hover:bg-gray-700/50 cursor-pointer"
                        onClick={() => dep.node && props.onFocusNode(dep.node)}
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
                        <span class="text-xs truncate flex-1 text-gray-300 group-hover:text-white">
                          {dep.name}
                        </span>
                        <Show when={dep.type === "optional"}>
                          <span class="text-[10px] text-gray-500">(opt)</span>
                        </Show>
                      </button>
                    </Tooltip>
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>

      <button
        onClick={props.onAnalyzeRemoval}
        class="w-full mt-4 px-3 py-2.5 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm flex items-center justify-center gap-2 transition-colors"
      >
        <i class="i-hugeicons-delete-02 w-4 h-4" />
        {tg()?.panel?.analyzeRemoval || "Analyze Removal"}
      </button>
    </div>
  );
}
