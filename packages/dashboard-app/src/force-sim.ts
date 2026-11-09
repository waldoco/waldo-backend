// Ported unchanged from waldo-landing components/site/see/force-sim.ts (the Spots and constellations map).
// A small force simulation, written to behave like the one on andrewtrousdale.com (which is d3-force, read from
// that site's own script on 2026-10-05). Same three forces with the same rules, in the same order:
//
//   link     every link is a spring (strength 0.1) that pulls its two ends towards a rest distance. The pull is
//            shared by how many links each end has: the end with more links moves less. (d3's forceLink)
//   charge   every node pushes every other node away, harder when close (strength -400 there, distance 10 to 300).
//            Nodes are few here, so each is tested against each, with no tree. (d3's forceManyBody)
//   centre   after the other forces, every node is shifted so that the middle of all of them sits on one point.
//            This is why dragging the main node stretches the web instead of carrying it away. (d3's forceCenter)
//
// Each tick: alpha moves towards its target, the forces add to each node's velocity (scaled by alpha), then
// every node moves by its velocity, which is cut to 0.6 of itself. A node with fx/fy set is held there, which
// is how a node is dragged. The sim runs on its own clock (60 ticks a second, whatever the screen) and stops
// when alpha has run down to alphaMin, unless a target keeps it warm (dragging sets 0.3).

export type SimNode = { id: string; x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null };
export type SimLink = { source: string; target: string; distance: number };
export type SimParams = { strength: number; charge: number; chargeMax: number; chargeMin: number };

const DECAY = 1 - Math.pow(0.001, 1 / 300);
const ALPHA_MIN = 0.001;
const VELOCITY_KEEP = 0.6;
const STEP = 1000 / 60;
const jiggle = () => (Math.random() - 0.5) * 1e-6;

export class ForceSim {
  nodes: SimNode[] = [];
  private links: { s: SimNode; t: SimNode; distance: number; bias: number }[] = [];
  alpha = 1;
  private target = 0;
  private cx = 0;
  private cy = 0;
  private bounds: { w: number; h: number; pad: number } | null = null;
  private params: SimParams = { strength: 0.1, charge: -400, chargeMax: 300, chargeMin: 10 };
  private frame = 0;
  private last = 0;
  private lag = 0;
  private onTick: () => void = () => {};

  constructor(onTick: () => void) {
    this.onTick = onTick;
  }

  setParams(p: Partial<SimParams>) {
    this.params = { ...this.params, ...p };
  }
  setCentre(x: number, y: number) {
    this.cx = x;
    this.cy = y;
  }
  /** Nodes are kept inside this box (less a margin) unless they are held */
  setBounds(w: number, h: number, pad: number) {
    this.bounds = { w, h, pad };
  }
  setGraph(nodes: SimNode[], links: SimLink[]) {
    this.nodes = nodes;
    const by = new Map(nodes.map((n) => [n.id, n]));
    const count = new Map<string, number>();
    const built = links.flatMap((l) => {
      const s = by.get(l.source);
      const t = by.get(l.target);
      if (!s || !t) return [];
      count.set(s.id, (count.get(s.id) ?? 0) + 1);
      count.set(t.id, (count.get(t.id) ?? 0) + 1);
      return [{ s, t, distance: l.distance, bias: 0 }];
    });
    built.forEach((l) => (l.bias = count.get(l.s.id)! / (count.get(l.s.id)! + count.get(l.t.id)!)));
    this.links = built;
  }
  alphaTarget(v: number) {
    this.target = v;
    return this;
  }
  restart(alpha?: number) {
    if (alpha !== undefined) this.alpha = alpha;
    if (!this.frame) {
      this.last = performance.now();
      this.lag = 0;
      this.frame = requestAnimationFrame(this.loop);
    }
    return this;
  }
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  /** Run the sim to rest at once, for people who have asked for less motion */
  settle(ticks = 300) {
    for (let i = 0; i < ticks && this.alpha >= ALPHA_MIN; i++) this.tick();
    this.onTick();
  }

  private loop = (now: number) => {
    this.lag += Math.min(now - this.last, 100);
    this.last = now;
    while (this.lag >= STEP) {
      this.tick();
      this.lag -= STEP;
    }
    this.onTick();
    if (this.alpha < ALPHA_MIN && this.target === 0) {
      this.frame = 0;
      return;
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  tick() {
    const { nodes, links, params } = this;
    this.alpha += (this.target - this.alpha) * DECAY;
    const a = this.alpha;

    // link
    for (const l of links) {
      let x = l.t.x + l.t.vx - l.s.x - l.s.vx || jiggle();
      let y = l.t.y + l.t.vy - l.s.y - l.s.vy || jiggle();
      let d = Math.sqrt(x * x + y * y);
      d = ((d - l.distance) / d) * a * params.strength;
      x *= d;
      y *= d;
      l.t.vx -= x * l.bias;
      l.t.vy -= y * l.bias;
      l.s.vx += x * (1 - l.bias);
      l.s.vy += y * (1 - l.bias);
    }

    // charge
    const max2 = params.chargeMax * params.chargeMax;
    const min2 = params.chargeMin * params.chargeMin;
    for (const n of nodes) {
      for (const m of nodes) {
        if (m === n) continue;
        let x = m.x - n.x;
        let y = m.y - n.y;
        let l = x * x + y * y;
        if (l >= max2) continue;
        if (x === 0) l += (x = jiggle()) * x;
        if (y === 0) l += (y = jiggle()) * y;
        if (l < min2) l = Math.sqrt(min2 * l);
        const w = (params.charge * a) / l;
        n.vx += x * w;
        n.vy += y * w;
      }
    }

    // centre
    if (nodes.length) {
      let sx = 0;
      let sy = 0;
      for (const n of nodes) {
        sx += n.x;
        sy += n.y;
      }
      sx = sx / nodes.length - this.cx;
      sy = sy / nodes.length - this.cy;
      for (const n of nodes) {
        n.x -= sx;
        n.y -= sy;
      }
    }

    // move
    for (const n of nodes) {
      if (n.fx == null) n.x += n.vx *= VELOCITY_KEEP;
      else {
        n.x = n.fx;
        n.vx = 0;
      }
      if (n.fy == null) n.y += n.vy *= VELOCITY_KEEP;
      else {
        n.y = n.fy;
        n.vy = 0;
      }
      if (this.bounds && n.fx == null && n.fy == null) {
        const { w, h, pad } = this.bounds;
        if (n.x < pad) {
          n.x = pad;
          n.vx = Math.abs(n.vx) * 0.5;
        } else if (n.x > w - pad) {
          n.x = w - pad;
          n.vx = -Math.abs(n.vx) * 0.5;
        }
        if (n.y < pad) {
          n.y = pad;
          n.vy = Math.abs(n.vy) * 0.5;
        } else if (n.y > h - pad) {
          n.y = h - pad;
          n.vy = -Math.abs(n.vy) * 0.5;
        }
      }
    }
  }
}
