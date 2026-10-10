// A short confetti burst in the lion's flame colours, fired from both bottom corners.
const COLOURS = ["#ffd91a", "#ffb000", "#ff8a1f", "#e8301c", "#e8b04b", "#ffffff"];

export function confetti({ count = 180, duration = 5000 } = {}) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:40";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; };
  resize();
  addEventListener("resize", resize);

  const scale = Math.min(1, innerWidth / 1200) * 0.5 + 0.5;   // smaller throws on phones
  const parts = Array.from({ length: count }, (_, i) => {
    const left = i % 2 === 0;
    return {
      x: left ? -10 : innerWidth + 10,
      y: innerHeight * (0.6 + Math.random() * 0.35),
      vx: (left ? 1 : -1) * (250 + Math.random() * 750) * scale,
      vy: -(650 + Math.random() * 750) * scale,
      w: 6 + Math.random() * 7,
      h: 4 + Math.random() * 6,
      a: Math.random() * 6.28,
      va: (Math.random() - 0.5) * 12,
      sway: Math.random() * 6.28,
      c: COLOURS[i % COLOURS.length]
    };
  });

  const start = performance.now();
  let last = start;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.033);
    const t = now - start;
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = t > duration - 900 ? Math.max(0, (duration - t) / 900) : 1;
    for (const p of parts) {
      p.vy = Math.min(p.vy + 1500 * dt, 230);        // flutters down instead of dropping
      p.vx *= 1 - 1.4 * dt;
      p.x += (p.vx + Math.sin(p.sway + t / 280) * 40) * dt;
      p.y += p.vy * dt;
      p.a += p.va * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.a * 1.7)) + 1);
      ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else { canvas.remove(); removeEventListener("resize", resize); }
  }
  requestAnimationFrame(frame);
}
