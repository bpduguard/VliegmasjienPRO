// ✦ Easter egg ✦ — type "space invaders" in the search box + Enter and the map
// turns into a Space Invaders game where the live aircraft are the invaders.
// Self-contained: it borrows `state` (live aircraft), `planeSvg` and the
// CLASS_COLORS from app.js via the shared global scope, and posts highscores to
// /api/invaders/highscores. Quit with Esc.
(function () {
  'use strict';
  const MAGIC = 'space invaders';

  // ---- wiring: listen for the magic phrase in the airline search box ----------
  function init() {
    const input = document.getElementById('airline-filter');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim().toLowerCase() === MAGIC) {
        e.preventDefault();
        input.value = '';
        input.dispatchEvent(new Event('input')); // reset the airline filter
        start();
      }
    });
  }

  // ---- helpers ----------------------------------------------------------------
  const CAT_COLOR = (typeof CLASS_COLORS !== 'undefined') ? CLASS_COLORS : {};
  const FALLBACK_COLORS = ['#38bdf8', '#4ade80', '#facc15', '#c084fc', '#f87171', '#22d3ee'];
  const imgCache = new Map();
  function planeImage(kind, color) {
    const key = kind + '|' + color;
    if (imgCache.has(key)) return imgCache.get(key);
    let img = null;
    try {
      const svg = planeSvg(kind || 'airliner', color, 180, false); // 180° = pointing down at the player
      img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    } catch { img = null; }
    imgCache.set(key, img);
    return img;
  }
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let game = null; // the running game, or null

  function start() {
    if (game) return;
    game = createGame();
    game.begin();
  }

  function createGame() {
    // ---- overlay DOM --------------------------------------------------------
    const root = document.createElement('div');
    root.id = 'invaders';
    root.innerHTML = `
      <canvas></canvas>
      <div class="inv-hud">
        <span class="inv-score">SCORE 0</span>
        <span class="inv-level">WAVE 1</span>
        <span class="inv-lives">♥♥♥</span>
        <button class="inv-quit" title="Quit (Esc)">✕ QUIT</button>
      </div>
      <div class="inv-overlay hidden"></div>`;
    document.body.appendChild(root);
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const hudScore = root.querySelector('.inv-score');
    const hudLevel = root.querySelector('.inv-level');
    const hudLives = root.querySelector('.inv-lives');
    const overlay = root.querySelector('.inv-overlay');

    let W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ---- state --------------------------------------------------------------
    const keys = new Set();
    const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), z: rand(0.3, 1) }));
    let player, bullets, invaders, particles;
    let score, lives, level, running, over, paused;
    let spawnTimer, spawnEvery, fireCD, invuln, lastT, raf;
    const seenHexes = new Set();   // aircraft already turned into invaders
    const pending = [];            // queued aircraft identities to spawn

    function reset() {
      player = { x: W / 2, y: 0, w: 40, h: 22, speed: 460 };
      bullets = []; invaders = []; particles = [];
      score = 0; lives = 3; level = 1; running = true; over = false; paused = false;
      spawnTimer = 0; spawnEvery = 1.1; fireCD = 0; invuln = 0; lastT = 0;
      seenHexes.clear(); pending.length = 0;
      // seed the pending queue with the aircraft currently on the map
      enqueueAircraft();
      updateHud();
    }

    function aircraftList() {
      try { return (typeof state !== 'undefined' && state.aircraft) ? [...state.aircraft.values()] : []; }
      catch { return []; }
    }
    function enqueueAircraft() {
      for (const ac of aircraftList()) {
        if (!ac || !ac.hex || seenHexes.has(ac.hex)) continue;
        seenHexes.add(ac.hex);
        pending.push({
          hex: ac.hex,
          label: ac.flight || ac.registration || ac.hex.toUpperCase(),
          kind: ac.iconKind || 'airliner',
          color: ac.emergency ? (CAT_COLOR.emergency || '#f87171') : (CAT_COLOR[ac.classification] || FALLBACK_COLORS[pending.length % FALLBACK_COLORS.length])
        });
      }
    }
    let genericN = 0;
    function nextIdentity() {
      if (pending.length) return pending.shift();
      // no (new) aircraft available — make a generic plane so waves keep coming
      genericN++;
      return { hex: null, label: 'BOGEY' + genericN, kind: 'airliner', color: FALLBACK_COLORS[genericN % FALLBACK_COLORS.length] };
    }

    function spawnInvader() {
      const id = nextIdentity();
      const w = 34, h = 34;
      invaders.push({
        x: rand(w, W - w), y: -h, w, h,
        vx: rand(-30, 30), vy: rand(34, 52) + level * 6,
        phase: Math.random() * Math.PI * 2, wob: rand(18, 40),
        img: planeImage(id.kind, id.color), color: id.color, label: id.label
      });
    }

    function explode(x, y, color) {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, s = rand(40, 220);
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), color });
      }
    }

    function fire() {
      if (fireCD > 0 || over || paused) return;
      bullets.push({ x: player.x, y: player.y - player.h / 2, vy: -640 });
      fireCD = 0.22;
    }

    function loseLife() {
      lives--; invuln = 1.4; updateHud();
      explode(player.x, player.y, '#fca5a5');
      if (lives <= 0) endGame();
    }

    function updateHud() {
      hudScore.textContent = 'SCORE ' + score;
      hudLevel.textContent = 'WAVE ' + level;
      hudLives.textContent = lives > 0 ? '♥'.repeat(lives) : '—';
    }

    // ---- main loop ----------------------------------------------------------
    function frame(t) {
      if (!running) return;
      const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0);
      lastT = t;
      if (!paused && !over) step(dt);
      draw();
      raf = requestAnimationFrame(frame);
    }

    function step(dt) {
      // difficulty ramps with the score
      level = 1 + Math.floor(score / 300);
      spawnEvery = Math.max(0.32, 1.1 - level * 0.06);

      // player movement
      const left = keys.has('arrowleft') || keys.has('a');
      const right = keys.has('arrowright') || keys.has('d');
      if (left) player.x -= player.speed * dt;
      if (right) player.x += player.speed * dt;
      player.x = clamp(player.x, player.w / 2, W - player.w / 2);
      player.y = H - 48;
      if (keys.has(' ')) fire();
      if (fireCD > 0) fireCD -= dt;
      if (invuln > 0) invuln -= dt;

      // keep pulling in newly-seen aircraft as the live feed updates
      enqueueAircraft();

      // spawning
      spawnTimer -= dt;
      const target = 5 + level * 2;
      if (spawnTimer <= 0 && invaders.length < 40) {
        if (pending.length || invaders.length < target) spawnInvader();
        spawnTimer = spawnEvery;
      }

      // bullets
      for (const b of bullets) b.y += b.vy * dt;
      bullets = bullets.filter((b) => b.y > -20);

      // invaders descend + gently home toward the player ("fly to" the ship)
      const playerLine = player.y - player.h / 2;
      for (const inv of invaders) {
        inv.phase += dt * 2.5;
        const homing = clamp((player.x - inv.x) * 0.6, -60 - level * 8, 60 + level * 8);
        inv.x += (inv.vx + homing) * dt + Math.sin(inv.phase) * inv.wob * dt;
        inv.y += inv.vy * dt;
        inv.x = clamp(inv.x, inv.w / 2, W - inv.w / 2);
        // reached the bottom, or rammed the ship → costs a life
        if (inv.y - inv.h / 2 > playerLine) {
          inv.dead = true;
          if (invuln <= 0) loseLife();
        } else if (invuln <= 0 && Math.abs(inv.x - player.x) < (inv.w + player.w) / 2 && Math.abs(inv.y - player.y) < (inv.h + player.h) / 2) {
          inv.dead = true; explode(inv.x, inv.y, inv.color); loseLife();
        }
      }

      // bullet ↔ invader collisions
      for (const b of bullets) {
        for (const inv of invaders) {
          if (inv.dead) continue;
          if (Math.abs(b.x - inv.x) < inv.w / 2 && Math.abs(b.y - inv.y) < inv.h / 2) {
            inv.dead = true; b.dead = true;
            score += 10 + level * 5; updateHud();
            explode(inv.x, inv.y, inv.color);
            break;
          }
        }
      }
      bullets = bullets.filter((b) => !b.dead);
      invaders = invaders.filter((inv) => !inv.dead);

      // particles + stars
      for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
      particles = particles.filter((p) => p.life > 0);
      for (const s of stars) { s.y += (0.04 + s.z * 0.10) * dt; if (s.y > 1) { s.y = 0; s.x = Math.random(); } }
    }

    function draw() {
      ctx.fillStyle = '#04060d'; ctx.fillRect(0, 0, W, H);
      // starfield
      for (const s of stars) { ctx.globalAlpha = 0.25 + s.z * 0.6; ctx.fillStyle = '#9fb4d6'; const sz = s.z * 2; ctx.fillRect(s.x * W, s.y * H, sz, sz); }
      ctx.globalAlpha = 1;

      // invaders (the planes, diving)
      for (const inv of invaders) {
        if (inv.img && inv.img.complete && inv.img.naturalWidth) {
          ctx.drawImage(inv.img, inv.x - inv.w / 2, inv.y - inv.h / 2, inv.w, inv.h);
        } else {
          ctx.fillStyle = inv.color; ctx.fillRect(inv.x - inv.w / 2, inv.y - inv.h / 2, inv.w, inv.h);
        }
        ctx.fillStyle = 'rgba(159,180,214,0.8)'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText(inv.label, inv.x, inv.y + inv.h / 2 + 9);
      }

      // bullets
      ctx.fillStyle = '#7dffa0';
      for (const b of bullets) ctx.fillRect(b.x - 1.5, b.y - 8, 3, 12);

      // particles
      for (const p of particles) { ctx.globalAlpha = Math.max(0, p.life * 1.6); ctx.fillStyle = p.color; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }
      ctx.globalAlpha = 1;

      // player ship (flashes while invulnerable)
      if (!over && !(invuln > 0 && Math.floor(invuln * 12) % 2)) drawShip(player.x, player.y);
    }

    function drawShip(x, y) {
      ctx.fillStyle = '#34d399';
      ctx.beginPath();
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x + 16, y + 10);
      ctx.lineTo(x + 6, y + 10);
      ctx.lineTo(x, y + 4);
      ctx.lineTo(x - 6, y + 10);
      ctx.lineTo(x - 16, y + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - 2, y - 16, 4, 6); // cannon
    }

    // ---- game over + highscores --------------------------------------------
    async function endGame() {
      over = true; running = true; // keep drawing the field behind the panel
      let data = { scores: [] };
      const lastName = localStorage.getItem('inv-name') || '';
      overlay.classList.remove('hidden');
      overlay.innerHTML = `<div class="inv-panel"><div class="inv-title">GAME OVER</div>
        <div class="inv-final">SCORE ${score}</div>
        <div class="inv-sub">loading highscores…</div></div>`;
      try { data = await (await fetch('/api/invaders/highscores')).json(); } catch { /* offline */ }
      const scores = data.scores || [];
      const qualifies = score > 0 && (scores.length < 10 || score > (scores[scores.length - 1]?.score ?? 0));
      const board = (list, hi) => '<table class="inv-board">' + list.map((s, i) =>
        `<tr class="${hi === i ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${s.score}</td></tr>`).join('') + '</table>';
      overlay.innerHTML = `<div class="inv-panel">
        <div class="inv-title">GAME OVER</div>
        <div class="inv-final">SCORE ${score}</div>
        ${qualifies ? `<div class="inv-sub">New highscore! Enter your name:</div>
          <div class="inv-row"><input class="inv-name" maxlength="12" value="${escapeHtml(lastName)}" placeholder="AAA" />
          <button class="inv-save">SAVE</button></div>` : '<div class="inv-sub">Highscores</div>'}
        <div class="inv-boardwrap">${board(scores.slice(0, 10), -1)}</div>
        <div class="inv-actions"><button class="inv-again">▶ PLAY AGAIN</button><button class="inv-back">✕ BACK TO MAP</button></div>
      </div>`;
      wireOverPanel(qualifies);
    }

    function wireOverPanel(qualifies) {
      const nameInput = overlay.querySelector('.inv-name');
      const save = overlay.querySelector('.inv-save');
      const submit = async () => {
        const name = (nameInput.value || 'AAA').trim().slice(0, 12) || 'AAA';
        localStorage.setItem('inv-name', name);
        save.disabled = true; save.textContent = 'SAVED';
        let res = { scores: [], rank: null };
        try { res = await (await fetch('/api/invaders/highscores', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, score }) })).json(); } catch { /* ignore */ }
        const hi = res.rank ? res.rank - 1 : -1;
        const board = '<table class="inv-board">' + (res.scores || []).map((s, i) =>
          `<tr class="${hi === i ? 'me' : ''}"><td>${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${s.score}</td></tr>`).join('') + '</table>';
        overlay.querySelector('.inv-boardwrap').innerHTML = board;
        const row = overlay.querySelector('.inv-row'); if (row) row.style.display = 'none';
      };
      if (qualifies && save) {
        save.addEventListener('click', submit);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); submit(); } });
        setTimeout(() => nameInput.focus(), 30);
      }
      overlay.querySelector('.inv-again').addEventListener('click', () => { overlay.classList.add('hidden'); reset(); });
      overlay.querySelector('.inv-back').addEventListener('click', quit);
    }

    function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    // ---- input + lifecycle --------------------------------------------------
    function onKeyDown(e) {
      const k = e.key.toLowerCase();
      if (k === 'escape') { quit(); return; }
      // don't hijack typing in the name field
      if (document.activeElement && document.activeElement.classList.contains('inv-name')) return;
      if (k === 'p' && !over) { paused = !paused; }
      if ([' ', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd'].includes(k)) e.preventDefault();
      keys.add(k);
    }
    function onKeyUp(e) { keys.delete(e.key.toLowerCase()); }

    function begin() {
      resize();
      reset();
      window.addEventListener('keydown', onKeyDown, { passive: false });
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('resize', resize);
      requestAnimationFrame((t) => { lastT = t; raf = requestAnimationFrame(frame); });
      requestAnimationFrame(() => root.classList.add('show')); // fade-in transition
    }

    function quit() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', resize);
      root.classList.remove('show');
      setTimeout(() => { root.remove(); }, 350);
      game = null;
    }

    return {
      begin, quit,
      _peek: () => ({ score, lives, level, invaders: invaders.length, over, paused }),
      _setScore: (n) => { score = n; updateHud(); },   // test hook
      _forceOver: () => endGame(),                       // test hook
      _spawnAt: (dx, up) => invaders.push({             // test hook: invader above the ship
        x: player.x + dx, y: player.y - (up || 120), w: 34, h: 34, vx: 0, vy: 0,
        phase: 0, wob: 0, img: null, color: '#38bdf8', label: 'TEST'
      })
    };
  }

  // expose for the trigger + tests
  window.VMInvaders = { start, _game: () => game };

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
