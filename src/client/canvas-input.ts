import type { AppState } from "./app-types.js";
import type { BoardRenderer } from "./render.js";
import { TAP_SLOP } from "./helpers.js";

export function bindCanvasInput(options: {
  canvas: HTMLCanvasElement;
  state: AppState;
  renderer: BoardRenderer;
  isPlayableCell: (cube: ReturnType<BoardRenderer["screenToCube"]>) => boolean;
  updateHovered: (x: number, y: number) => void;
  toggleSelected: (cube: ReturnType<BoardRenderer["screenToCube"]>) => void;
  closeSettings: () => void;
  isSettingsOpen: () => boolean;
}): void {
  const { canvas, state, renderer, isPlayableCell, updateHovered, toggleSelected, closeSettings, isSettingsOpen } = options;

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    updateHovered(event.clientX, event.clientY);

    if (event.pointerType === "touch") {
      state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (state.touchPoints.size >= 2) {
        state.multiTouchGesture = true;
        state.pointer = null;
        state.pinchGesture = getTouchGesture(state);
        canvas.classList.add("dragging");
        renderer.requestRender();
        return;
      }
    }

    state.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dragging: false,
    };
    canvas.classList.add("dragging");
    renderer.requestRender();
  });

  canvas.addEventListener("pointermove", (event) => {
    updateHovered(event.clientX, event.clientY);
    if (event.pointerType === "touch" && state.touchPoints.has(event.pointerId)) {
      state.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = getTouchGesture(state);
      if (state.touchPoints.size >= 2 && gesture && state.pinchGesture) {
        state.camera.x += gesture.midpointX - state.pinchGesture.midpointX;
        state.camera.y += gesture.midpointY - state.pinchGesture.midpointY;
        if (state.pinchGesture.distance > 0 && gesture.distance > 0) {
          renderer.zoomAt(gesture.midpointX, gesture.midpointY, gesture.distance / state.pinchGesture.distance);
        }
        state.multiTouchGesture = true;
        state.pinchGesture = gesture;
        renderer.requestRender();
        return;
      }
    }

    if (!state.pointer || state.pointer.id !== event.pointerId) {
      renderer.requestRender();
      return;
    }

    const totalDx = event.clientX - state.pointer.startX;
    const totalDy = event.clientY - state.pointer.startY;
    if (!state.pointer.dragging && Math.hypot(totalDx, totalDy) > TAP_SLOP) {
      state.pointer.dragging = true;
    }
    if (state.pointer.dragging) {
      state.camera.x += event.clientX - state.pointer.lastX;
      state.camera.y += event.clientY - state.pointer.lastY;
    }
    state.pointer.lastX = event.clientX;
    state.pointer.lastY = event.clientY;
    renderer.requestRender();
  });

  const finishPointer = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      state.touchPoints.delete(event.pointerId);
      if (state.touchPoints.size < 2) {
        state.pinchGesture = null;
        state.multiTouchGesture = false;
      }
    }

    if (!state.pointer || state.pointer.id !== event.pointerId) {
      if (state.touchPoints.size === 0) canvas.classList.remove("dragging");
      renderer.requestRender();
      return;
    }

    updateHovered(event.clientX, event.clientY);
    if (!state.multiTouchGesture && !state.pointer.dragging && state.hovered && isPlayableCell(state.hovered)) {
      toggleSelected(state.hovered);
    }
    if (state.touchPoints.size === 0) canvas.classList.remove("dragging");
    state.pointer = null;
    renderer.requestRender();
  };

  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("pointerleave", () => {
    if (!state.pointer) {
      state.hovered = null;
      renderer.requestRender();
    }
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      renderer.zoomAt(event.clientX, event.clientY, Math.exp((-event.deltaY * scale) / 1200));
    } else {
      state.camera.x -= event.deltaX * scale;
      state.camera.y -= event.deltaY * scale;
    }
    updateHovered(event.clientX, event.clientY);
    renderer.requestRender();
  }, { passive: false });

  window.addEventListener("resize", () => renderer.resizeCanvas());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsOpen()) {
      closeSettings();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      renderer.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.12);
    } else if (event.key === "-") {
      renderer.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.12);
    } else {
      return;
    }
    renderer.requestRender();
  });
}

function getTouchGesture(state: AppState): AppState["pinchGesture"] {
  if (state.touchPoints.size < 2) return null;
  const [first, second] = Array.from(state.touchPoints.values());
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  return {
    midpointX: (first.x + second.x) / 2,
    midpointY: (first.y + second.y) / 2,
    distance: Math.hypot(dx, dy),
  };
}
