/**
 * Simple Elite - Starry background (lightweight)
 * Based on TrendStage `webapp/starry.js`, tuned to be subtle (not overwhelming).
 *
 * It creates:
 * - fixed dark background div (z-index: -2)
 * - fixed full-screen canvas for stars (z-index: -1)
 *
 * It is "zone aware": it concentrates stars in gaps around elements with `.zone`.
 * In Simple Elite we mark the left and right panes as `.zone`.
 */
(function () {
  "use strict";

  const COLORS = {
    stars: ["#ffffff", "#a0c4ff", "#c4b5fd"],
    shootingStart: "#ffffff",
    shootingEnd: "#a0c4ff",
  };

  // Tuned down from the original (less dense, slower shooting stars)
  const CONFIG = {
    starCount: 140,
    starMinSize: 1.1,
    starMaxSize: 2.6,
    starMinOpacity: 0.22,
    starMaxOpacity: 0.7,
    gapStarRatio: 0.75,
    shootingMinInterval: 5200,
    shootingMaxInterval: 9000,
    shootingSpeed: 360,
    shootingMinLength: 70,
    shootingMaxLength: 120,
  };

  let canvas, ctx;
  let stars = [];
  let shootingStars = [];
  let gapAreas = [];
  let gapCenter = { x: 0, y: 0 };
  let lastShootingTime = 0;
  let nextShootingDelay = 7000;
  let lastTime = 0;

  function detectGapAreas() {
    gapAreas = [];
    const zones = document.querySelectorAll(".zone");

    if (zones.length === 0) {
      gapAreas.push({
        x: window.innerWidth * 0.25,
        y: window.innerHeight * 0.2,
        width: window.innerWidth * 0.5,
        height: window.innerHeight * 0.6,
      });
    } else {
      const zoneRects = Array.from(zones).map((z) => {
        const rect = z.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });

      const minX = Math.min(...zoneRects.map((r) => r.left));
      const maxX = Math.max(...zoneRects.map((r) => r.right));
      const minY = Math.min(...zoneRects.map((r) => r.top));
      const maxY = Math.max(...zoneRects.map((r) => r.bottom));

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      gapAreas.push({ x: centerX - 60, y: centerY - 60, width: 120, height: 120 });

      // Edge gaps around the zone grid
      gapAreas.push({ x: minX, y: 0, width: maxX - minX, height: minY }); // top
      gapAreas.push({ x: minX, y: maxY, width: maxX - minX, height: window.innerHeight - maxY }); // bottom
      gapAreas.push({ x: 0, y: minY, width: minX, height: maxY - minY }); // left
      gapAreas.push({ x: maxX, y: minY, width: window.innerWidth - maxX, height: maxY - minY }); // right
    }

    let totalArea = 0;
    let weightedX = 0;
    let weightedY = 0;
    for (const gap of gapAreas) {
      const area = gap.width * gap.height;
      totalArea += area;
      weightedX += (gap.x + gap.width / 2) * area;
      weightedY += (gap.y + gap.height / 2) * area;
    }
    gapCenter =
      totalArea > 0
        ? { x: weightedX / totalArea, y: weightedY / totalArea }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  function getRandomGapPoint() {
    if (gapAreas.length === 0) return { x: Math.random() * canvas.width, y: Math.random() * canvas.height };
    let totalArea = 0;
    for (const gap of gapAreas) totalArea += gap.width * gap.height;

    let random = Math.random() * totalArea;
    for (const gap of gapAreas) {
      random -= gap.width * gap.height;
      if (random <= 0) return { x: gap.x + Math.random() * gap.width, y: gap.y + Math.random() * gap.height };
    }
    const lastGap = gapAreas[gapAreas.length - 1];
    return { x: lastGap.x + Math.random() * lastGap.width, y: lastGap.y + Math.random() * lastGap.height };
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function redistributeStars() {
    const gapStars = Math.floor(CONFIG.starCount * CONFIG.gapStarRatio);
    const ambientStars = CONFIG.starCount - gapStars;

    stars = [];

    for (let i = 0; i < gapStars; i++) {
      const point = getRandomGapPoint();
      stars.push({
        x: point.x,
        y: point.y,
        size: CONFIG.starMinSize + Math.random() * (CONFIG.starMaxSize - CONFIG.starMinSize),
        color: COLORS.stars[Math.floor(Math.random() * COLORS.stars.length)],
        baseOpacity: CONFIG.starMinOpacity + Math.random() * (CONFIG.starMaxOpacity - CONFIG.starMinOpacity),
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.25 + Math.random() * 0.6,
      });
    }

    for (let i = 0; i < ambientStars; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: CONFIG.starMinSize + Math.random() * (CONFIG.starMaxSize - CONFIG.starMinSize) * 0.7,
        color: COLORS.stars[Math.floor(Math.random() * COLORS.stars.length)],
        baseOpacity: CONFIG.starMinOpacity * 0.6 + Math.random() * (CONFIG.starMaxOpacity - CONFIG.starMinOpacity) * 0.45,
        twinklePhase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.2 + Math.random() * 0.5,
      });
    }
  }

  function spawnShootingStar() {
    const target = gapCenter;
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    switch (edge) {
      case 0:
        x = Math.random() * canvas.width;
        y = -20;
        break;
      case 1:
        x = canvas.width + 20;
        y = Math.random() * canvas.height * 0.6;
        break;
      case 2:
        x = Math.random() * canvas.width;
        y = canvas.height + 20;
        break;
      default:
        x = -20;
        y = Math.random() * canvas.height * 0.6;
        break;
    }

    const angle = Math.atan2(target.y - y, target.x - x);
    const length = CONFIG.shootingMinLength + Math.random() * (CONFIG.shootingMaxLength - CONFIG.shootingMinLength);

    shootingStars.push({
      x,
      y,
      vx: Math.cos(angle) * CONFIG.shootingSpeed,
      vy: Math.sin(angle) * CONFIG.shootingSpeed,
      life: 0,
      maxLife: 1.2 + Math.random() * 0.6,
      length,
    });
  }

  function draw(time) {
    const t = (time || 0) / 1000;
    const dt = Math.min(0.05, (t - lastTime) || 0.016);
    lastTime = t;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Stars
    for (const s of stars) {
      const tw = Math.sin(t * s.twinkleSpeed + s.twinklePhase) * 0.18 + 1;
      const opacity = Math.max(0, Math.min(1, s.baseOpacity * tw));
      ctx.globalAlpha = opacity;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Shooting stars
    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const st = shootingStars[i];
      st.life += dt;
      st.x += st.vx * dt;
      st.y += st.vy * dt;
      const p = st.life / st.maxLife;
      const alpha = p < 0.2 ? p / 0.2 : p > 0.9 ? (1 - p) / 0.1 : 1;
      if (alpha <= 0 || st.life >= st.maxLife) {
        shootingStars.splice(i, 1);
        continue;
      }

      const tailX = st.x - (st.vx / CONFIG.shootingSpeed) * st.length;
      const tailY = st.y - (st.vy / CONFIG.shootingSpeed) * st.length;

      const grad = ctx.createLinearGradient(st.x, st.y, tailX, tailY);
      grad.addColorStop(0, COLORS.shootingStart);
      grad.addColorStop(1, COLORS.shootingEnd);

      ctx.globalAlpha = alpha * 0.65;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(st.x, st.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Shooting star scheduling
    const now = performance.now();
    if (now - lastShootingTime > nextShootingDelay) {
      spawnShootingStar();
      lastShootingTime = now;
      nextShootingDelay =
        CONFIG.shootingMinInterval +
        Math.random() * (CONFIG.shootingMaxInterval - CONFIG.shootingMinInterval);
    }

    requestAnimationFrame(draw);
  }

  function init() {
    // Dark background layer (under the canvas)
    const bg = document.createElement("div");
    bg.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;background:#0f0f0f;z-index:-2;";
    document.body.insertBefore(bg, document.body.firstChild);

    canvas = document.createElement("canvas");
    canvas.id = "simpleEliteStarryCanvas";
    canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;";
    document.body.insertBefore(canvas, bg);

    ctx = canvas.getContext("2d");
    resize();
    detectGapAreas();
    redistributeStars();

    window.addEventListener("resize", () => {
      resize();
      detectGapAreas();
      redistributeStars();
    });

    setTimeout(() => {
      detectGapAreas();
      redistributeStars();
    }, 800);

    requestAnimationFrame(draw);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

