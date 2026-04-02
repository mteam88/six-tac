import type { Cube, SessionView, Seat, Stone } from "../domain/types.js";

const SQRT3 = Math.sqrt(3);

export type CameraState = {
  x: number;
  y: number;
  scale: number;
};

export type BoardRenderState = {
  hexSize: number;
  camera: CameraState;
  hovered: Cube | null;
  selected: Cube[];
  session: SessionView | null;
  recentHighlights: Cube[];
};

export class BoardRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly getState: () => BoardRenderState;
  private rafPending = false;

  constructor(canvas: HTMLCanvasElement, getState: () => BoardRenderState) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context unavailable");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.getState = getState;
  }

  requestRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => this.render());
  }

  resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestRender();
  }

  hexToPixel(cube: Cube, size = this.getState().hexSize): { x: number; y: number } {
    return {
      x: size * SQRT3 * (cube.x + cube.z / 2),
      y: size * 1.5 * cube.z,
    };
  }

  pixelToFractionalCube(x: number, y: number, size = this.getState().hexSize): Cube {
    const q = ((SQRT3 / 3) * x - y / 3) / size;
    const r = ((2 / 3) * y) / size;
    const s = -q - r;
    return { x: q, y: s, z: r };
  }

  cubeRound(cube: Cube): Cube {
    let rx = Math.round(cube.x);
    let ry = Math.round(cube.y);
    let rz = Math.round(cube.z);

    const xDiff = Math.abs(rx - cube.x);
    const yDiff = Math.abs(ry - cube.y);
    const zDiff = Math.abs(rz - cube.z);

    if (xDiff > yDiff && xDiff > zDiff) {
      rx = -ry - rz;
    } else if (yDiff > zDiff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }

    return { x: rx, y: ry, z: rz };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    const state = this.getState();
    return {
      x: x * state.camera.scale + state.camera.x,
      y: y * state.camera.scale + state.camera.y,
    };
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    const state = this.getState();
    return {
      x: (x - state.camera.x) / state.camera.scale,
      y: (y - state.camera.y) / state.camera.scale,
    };
  }

  screenToCube(x: number, y: number): Cube {
    const world = this.screenToWorld(x, y);
    return this.cubeRound(this.pixelToFractionalCube(world.x, world.y));
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const state = this.getState();
    const worldBefore = this.screenToWorld(screenX, screenY);
    state.camera.scale *= factor;
    state.camera.x = screenX - worldBefore.x * state.camera.scale;
    state.camera.y = screenY - worldBefore.y * state.camera.scale;
  }

  cubesAreVisible(cubes: Cube[]): boolean {
    const margin = 100;
    return cubes.every((cube) => {
      const point = this.hexToPixel(cube);
      const screen = this.worldToScreen(point.x, point.y);
      return (
        screen.x >= margin &&
        screen.x <= window.innerWidth - margin &&
        screen.y >= margin &&
        screen.y <= window.innerHeight - margin
      );
    });
  }

  centerOnCubes(cubes: Cube[]): void {
    if (cubes.length === 0) return;
    const state = this.getState();
    let sumX = 0;
    let sumY = 0;
    for (const cube of cubes) {
      const point = this.hexToPixel(cube);
      sumX += point.x;
      sumY += point.y;
    }
    const avgX = sumX / cubes.length;
    const avgY = sumY / cubes.length;
    state.camera.x = window.innerWidth / 2 - avgX * state.camera.scale;
    state.camera.y = window.innerHeight / 2 - avgY * state.camera.scale;
  }

  private render(): void {
    this.rafPending = false;
    const state = this.getState();
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    const occupied = new Map<string, Stone>();
    for (const stone of state.session?.stones ?? []) {
      occupied.set(cubeKey(stone), stone);
    }

    const selected = new Set(state.selected.map(cubeKey));
    const recentHighlights = new Set(state.recentHighlights.map(cubeKey));
    const range = this.getVisibleRange();
    const hexRadius = state.hexSize * state.camera.scale;

    for (let q = range.minQ; q <= range.maxQ; q += 1) {
      for (let r = range.minR; r <= range.maxR; r += 1) {
        const cube = { x: q, y: -q - r, z: r };
        const point = this.hexToPixel(cube);
        const screen = this.worldToScreen(point.x, point.y);

        if (
          screen.x < -hexRadius * 2 ||
          screen.x > window.innerWidth + hexRadius * 2 ||
          screen.y < -hexRadius * 2 ||
          screen.y > window.innerHeight + hexRadius * 2
        ) {
          continue;
        }

        const stone = occupied.get(cubeKey(cube));
        const isHovered = sameCube(state.hovered, cube);
        const isSelected = selected.has(cubeKey(cube));
        const isRecent = recentHighlights.has(cubeKey(cube));
        const isInRange = stone ? true : isWithinPlacementRange(state.session, cube);

        let fill = "rgba(148, 163, 184, 0.06)";
        let stroke = "rgba(148, 163, 184, 0.26)";
        let lineWidth = Math.max(1, 1.4 * state.camera.scale);

        if (stone?.player === "One") {
          fill = "rgba(239, 68, 68, 0.72)";
          stroke = "rgba(254, 202, 202, 0.95)";
          lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
        } else if (stone?.player === "Two") {
          fill = "rgba(59, 130, 246, 0.72)";
          stroke = "rgba(191, 219, 254, 0.95)";
          lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
        } else if (isSelected) {
          const previewColor = seatColor(state.session?.seat ?? "spectator");
          fill = previewColor.fill;
          stroke = previewColor.stroke;
          lineWidth = Math.max(1.2, 1.8 * state.camera.scale);
        } else if (!isInRange) {
          fill = "rgba(148, 163, 184, 0.025)";
          stroke = "rgba(107, 114, 128, 0.24)";
        }

        if (isHovered) {
          if (!stone && !isSelected) {
            fill = "rgba(99, 102, 241, 0.18)";
          }
          stroke = "rgba(255, 255, 255, 0.92)";
          lineWidth = Math.max(lineWidth, Math.max(1.8, 2.4 * state.camera.scale));
        }

        this.drawHex(screen.x, screen.y, hexRadius, fill, stroke, lineWidth);

        if (isRecent) {
          this.drawRecentOutline(screen.x, screen.y, hexRadius);
        }
      }
    }
  }

  private getVisibleRange(): { minQ: number; maxQ: number; minR: number; maxR: number } {
    const corners = [
      this.screenToWorld(0, 0),
      this.screenToWorld(window.innerWidth, 0),
      this.screenToWorld(0, window.innerHeight),
      this.screenToWorld(window.innerWidth, window.innerHeight),
    ];

    const cubes = corners.map((point) => this.pixelToFractionalCube(point.x, point.y));
    const qs = cubes.map((cube) => cube.x);
    const rs = cubes.map((cube) => cube.z);

    return {
      minQ: Math.floor(Math.min(...qs)) - 3,
      maxQ: Math.ceil(Math.max(...qs)) + 3,
      minR: Math.floor(Math.min(...rs)) - 3,
      maxR: Math.ceil(Math.max(...rs)) + 3,
    };
  }

  private traceHex(centerX: number, centerY: number, radius: number): void {
    this.ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = ((60 * i - 30) * Math.PI) / 180;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.closePath();
  }

  private drawHex(
    centerX: number,
    centerY: number,
    radius: number,
    fillStyle: string,
    strokeStyle: string,
    lineWidth: number,
  ): void {
    this.traceHex(centerX, centerY, radius);
    this.ctx.fillStyle = fillStyle;
    this.ctx.fill();
    this.ctx.lineWidth = lineWidth;
    this.ctx.strokeStyle = strokeStyle;
    this.ctx.stroke();
  }

  private drawRecentOutline(centerX: number, centerY: number, radius: number): void {
    this.traceHex(centerX, centerY, radius);
    this.ctx.lineWidth = Math.max(2.2, 3 * this.getState().camera.scale);
    this.ctx.strokeStyle = "rgba(15, 23, 42, 0.96)";
    this.ctx.stroke();

    this.ctx.save();
    this.traceHex(centerX, centerY, radius);
    this.ctx.lineWidth = Math.max(1.6, 2.2 * this.getState().camera.scale);
    this.ctx.setLineDash([10 * this.getState().camera.scale, 8 * this.getState().camera.scale]);
    this.ctx.lineDashOffset = 2;
    this.ctx.strokeStyle = "rgba(250, 204, 21, 0.98)";
    this.ctx.stroke();
    this.ctx.restore();
  }
}

function cubeKey(cube: Cube): string {
  return `${cube.x},${cube.y},${cube.z}`;
}

function cubeDistance(a: Cube, b: Cube): number {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;
}

function sameCube(a: Cube | null, b: Cube | null): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function isWithinPlacementRange(session: SessionView | null, cube: Cube): boolean {
  const stones = session?.stones ?? [];
  return stones.some((stone) => cubeDistance(stone, cube) <= 8);
}

function seatColor(seat: Seat): { fill: string; stroke: string } {
  if (seat === "one") {
    return {
      fill: "rgba(239, 68, 68, 0.28)",
      stroke: "rgba(254, 202, 202, 0.95)",
    };
  }
  if (seat === "two" || seat === "local") {
    return {
      fill: "rgba(59, 130, 246, 0.28)",
      stroke: "rgba(191, 219, 254, 0.95)",
    };
  }
  return {
    fill: "rgba(148, 163, 184, 0.2)",
    stroke: "rgba(226, 232, 240, 0.8)",
  };
}
