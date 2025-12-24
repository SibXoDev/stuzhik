export interface SkeletonProps {
  class?: string;
  width?: string;
  height?: string;
  rounded?: "sm" | "md" | "lg" | "xl" | "full";
  variant?: "text" | "title" | "avatar" | "button" | "card";
}

export function Skeleton(props: SkeletonProps) {
  const roundedClass = () => {
    switch (props.rounded) {
      case "sm": return "rounded-sm";
      case "md": return "rounded-md";
      case "lg": return "rounded-lg";
      case "xl": return "rounded-xl";
      case "full": return "rounded-full";
      default: return "";
    }
  };

  const variantClass = () => {
    switch (props.variant) {
      case "text": return "skeleton-text";
      case "title": return "skeleton-title";
      case "avatar": return "skeleton-avatar";
      case "button": return "skeleton-button";
      case "card": return "";
      default: return "";
    }
  };

  return (
    <div
      class={`skeleton ${variantClass()} ${roundedClass()} ${props.class || ""}`}
      style={{
        width: props.width,
        height: props.height,
      }}
    />
  );
}

// Pre-built skeleton patterns
export function SkeletonCard() {
  return (
    <div class="card p-4 space-y-3">
      <div class="flex items-center gap-3">
        <Skeleton variant="avatar" width="40px" height="40px" />
        <div class="flex-1 space-y-2">
          <Skeleton variant="title" />
          <Skeleton variant="text" width="40%" />
        </div>
      </div>
      <Skeleton height="60px" rounded="lg" />
      <div class="flex gap-2">
        <Skeleton variant="button" width="80px" />
        <Skeleton variant="button" width="80px" />
      </div>
    </div>
  );
}

export function SkeletonList(props: { count?: number }) {
  const count = props.count ?? 3;
  return (
    <div class="space-y-3">
      {Array.from({ length: count }).map(() => (
        <div class="flex items-center gap-3">
          <Skeleton variant="avatar" width="32px" height="32px" />
          <div class="flex-1 space-y-1.5">
            <Skeleton variant="text" width="70%" />
            <Skeleton variant="text" width="40%" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
