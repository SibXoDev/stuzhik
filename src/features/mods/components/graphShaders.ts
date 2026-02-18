// WebGL2 shaders for DependencyGraph

export const VERTEX_SHADER_CIRCLE = `#version 300 es
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

export const FRAGMENT_SHADER_CIRCLE = `#version 300 es
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

export const VERTEX_SHADER_LINE = `#version 300 es
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

export const FRAGMENT_SHADER_LINE = `#version 300 es
  precision highp float;
  in vec4 v_color;
  out vec4 fragColor;
  void main() {
    fragColor = v_color;
  }
`;
