import { vi, beforeEach } from 'vitest';
import { Window } from 'happy-dom';
import '@testing-library/jest-dom/vitest';

// Setup happy-dom window
const window = new Window();
const document = window.document;

// Set globals
global.window = window as any;
global.document = document as any;
global.navigator = window.navigator as any;

// Create mock functions
const invokeMock = vi.fn();
const listenMock = vi.fn();
const onceMock = vi.fn();
const emitMock = vi.fn();

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
  once: onceMock,
  emit: emitMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    listen: listenMock,
    once: onceMock,
    emit: emitMock,
    onResized: vi.fn(() => Promise.resolve(() => {})),
    startDragging: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  })),
  appWindow: {
    listen: listenMock,
    once: onceMock,
    emit: emitMock,
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  open: vi.fn(),
}));

// Reset mocks before each test
beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  onceMock.mockReset();
  emitMock.mockReset();
});

// Mock WebGL context for canvas tests
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn((contextType) => {
    if (contextType === 'webgl2') {
      return {
      createShader: vi.fn(),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn(() => true),
      createProgram: vi.fn(),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn(() => true),
      useProgram: vi.fn(),
      createBuffer: vi.fn(),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      getAttribLocation: vi.fn(() => 0),
      getUniformLocation: vi.fn(() => ({})),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform3f: vi.fn(),
      uniform4f: vi.fn(),
      uniform1fv: vi.fn(),
      clearColor: vi.fn(),
      clear: vi.fn(),
      drawArrays: vi.fn(),
      viewport: vi.fn(),
      deleteShader: vi.fn(),
      deleteProgram: vi.fn(),
      deleteBuffer: vi.fn(),
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COLOR_BUFFER_BIT: 16384,
      TRIANGLES: 4,
      ARRAY_BUFFER: 34962,
      STATIC_DRAW: 35044,
      FLOAT: 5126,
    };
  }
  return null;
}) as any;
}
