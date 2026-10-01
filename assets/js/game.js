/* Comet vs. the Nut Armada: a tiny survivors-like for the under-construction page. */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const MAX_ENEMIES = 400;
  const MAX_GEMS = 260;
  const MAX_PARTICLES = 500;
  const MAX_TEXTS = 60;
  const MAX_R = 44; // largest enemy radius, used to pad spatial queries
  const JOY_RADIUS = 44;
  const BEST_KEY = 'comet-vs-nut-armada:best';

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const shell = $('game-shell');
  if (!canvas || !shell || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const ui = {
    hpFill: $('hp-fill'),
    hpText: $('hp-text'),
    xpFill: $('xp-fill'),
    level: $('hud-level'),
    time: $('hud-time'),
    kills: $('hud-kills'),
    toast: $('game-toast'),
    choices: $('choices'),
    levelTitle: $('levelup-title'),
    bestStart: $('best-start'),
    resultTime: $('result-time'),
    resultKills: $('result-kills'),
    resultLevel: $('result-level'),
    resultBest: $('result-best'),
    newBest: $('new-best'),
  };
  const overlays = {
    menu: $('overlay-start'),
    levelup: $('overlay-levelup'),
    paused: $('overlay-pause'),
    over: $('overlay-over'),
  };

  const store = {
    get(key) {
      try { return window.localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
    },
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mod = (a, n) => ((a % n) + n) % n;
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const xpNeeded = (level) => Math.round(3 + level * 1.5 + Math.pow(level, 1.3));

  /* ---------------------------------------------------------------- viewport */

  let vw = 1;
  let vh = 1;
  let dpr = 1;
  let zoom = 1; // world scale, so sprites stay readable on large screens
  let viewW = 1; // visible world size in world units
  let viewH = 1;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = Math.max(1, rect.width);
    vh = Math.max(1, rect.height);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    zoom = clamp(Math.min(vw, vh) / 480, 1, 1.45);
    viewW = vw / zoom;
    viewH = vh / zoom;
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ------------------------------------------------------------- definitions */

  // Levels past an upgrade's max are mastery ranks: +15% damage each, and every
  // third rank adds one more projectile (up to +6).
  const split = (l, max) => [Math.min(l, max), Math.max(0, l - max)];
  const masteryDmg = (r) => 1 + 0.15 * r;
  const masteryCount = (r) => Math.min(6, Math.floor(r / 3));
  const WEAPONS = {
    fetch: (l) => {
      const [c, r] = split(l, 6);
      return { count: 1 + Math.floor(c / 2) + masteryCount(r), dmg: (14 + 5 * (c - 1)) * masteryDmg(r), pierce: c >= 5 ? 2 : c >= 3 ? 1 : 0, cd: 0.75 - 0.05 * c };
    },
    bones: (l) => {
      const [c, r] = split(l, 5);
      return { count: c + 1 + masteryCount(r), dmg: (7 + 3 * c) * masteryDmg(r), radius: 56 + 6 * c, spin: 2.6 + 0.25 * c };
    },
    bark: (l) => {
      const [c, r] = split(l, 5);
      return { cd: 3.4 - 0.3 * c, radius: (95 + 22 * c) * (1 + 0.06 * Math.min(r, 10)), dmg: (12 + 6 * c) * masteryDmg(r), push: 260 + 30 * c };
    },
    comet: (l) => {
      const [c, r] = split(l, 5);
      return { count: Math.ceil(c / 2) + masteryCount(r), dmg: (16 + 6 * c) * masteryDmg(r), cd: 2.4 - 0.15 * c, range: 200 + 20 * c };
    },
  };
  const projectileMastery = (noun) => (r) => (r % 3 === 0 && r <= 18 ? `+1 ${noun} and +15% damage.` : '+15% damage.');

  const FETCH_TEXT = {
    1: 'Auto-fires tennis balls at the nearest foe.',
    2: '+1 ball and more damage.',
    3: 'Balls pierce through 1 extra enemy.',
    4: '+1 ball and more damage.',
    5: 'Balls pierce through 2 extra enemies.',
    6: '+1 ball. Maximum fetch.',
  };

  // `max` is the last regular level; `ranks` caps mastery ranks after it (Infinity = endless).
  const UPGRADES = [
    { id: 'fetch', max: 6, ranks: Infinity, icon: '🎾', name: 'Fetch Blaster', text: (l) => FETCH_TEXT[l], mastery: projectileMastery('ball') },
    { id: 'bones', max: 5, ranks: Infinity, icon: '🦴', name: 'Bone Orbit', text: (l) => (l === 1 ? 'Two bones orbit Comet and bonk anything they touch.' : '+1 bone, with a wider, faster orbit.'), mastery: projectileMastery('bone') },
    { id: 'bark', max: 5, ranks: Infinity, icon: '📣', name: 'Sonic Bark', text: (l) => (l === 1 ? 'A periodic bark shockwave that knocks foes back.' : 'Bigger, stronger, more frequent barks.'), mastery: (r) => (r <= 10 ? '+15% damage and a 6% bigger bark.' : '+15% damage.') },
    { id: 'comet', max: 5, ranks: Infinity, icon: '🥏', name: 'Comet Frisbee', text: (l) => (l === 1 ? 'A boomerang frisbee that slices through everything.' : l % 2 ? '+1 frisbee and more damage.' : 'More damage and range.'), mastery: projectileMastery('frisbee') },
    { id: 'speed', max: 5, ranks: 10, icon: '🚀', name: 'Rocket Paws', text: () => '+10% movement speed.', mastery: () => '+3% movement speed.' },
    { id: 'suit', max: 5, ranks: Infinity, icon: '🛡️', name: 'Reinforced Suit', text: () => '+20 max HP and patch up 20 HP.', mastery: () => '+10 max HP and patch up 10 HP.' },
    { id: 'magnet', max: 5, ranks: 10, icon: '🧲', name: 'Treat Magnet', text: () => '+40% kibble pickup radius.', mastery: () => '+15% kibble pickup radius.' },
    { id: 'regen', max: 5, ranks: Infinity, icon: '💚', name: 'Good Dog Aura', text: () => 'Regenerate +0.5 HP per second.', mastery: () => 'Regenerate +0.25 HP per second.' },
    { id: 'haste', max: 5, ranks: 15, icon: '⚡', name: 'Zoomies', text: () => 'Weapons recharge 8% faster.', mastery: () => 'Weapons recharge 3% faster.' },
    { id: 'power', max: 5, ranks: Infinity, icon: '💥', name: 'Big Bark Energy', text: () => '+12% damage to everything.', mastery: () => '+8% damage to everything.' },
  ];
  const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
  const TREAT = { id: 'treat', max: Infinity, icon: '🍖', name: 'Space Treat', text: () => 'Restore 40 HP.' };

  const ENEMY_TYPES = {
    squirrel: { hp: 10, speed: 74, r: 12, dmg: 8, xp: 1, color: '#d4843f' },
    bird: { hp: 7, speed: 112, r: 11, dmg: 6, xp: 1, color: '#8ea2e8' },
    raccoon: { hp: 48, speed: 52, r: 17, dmg: 14, xp: 3, color: '#9ca1b0' },
    goose: { hp: 140, speed: 90, r: 19, dmg: 18, xp: 8, color: '#f2f2f7' },
    boss: { hp: 2200, speed: 58, r: MAX_R, dmg: 30, xp: 0, color: '#ffd166' },
  };

  function derivedStats(g) {
    const L = g.levels;
    const [speed, speedR] = split(L.speed, 5);
    const [magnet, magnetR] = split(L.magnet, 5);
    const [regen, regenR] = split(L.regen, 5);
    const [haste, hasteR] = split(L.haste, 5);
    const [power, powerR] = split(L.power, 5);
    return {
      speed: 175 * (1 + 0.1 * speed + 0.03 * speedR),
      magnet: 110 * (1 + 0.4 * magnet + 0.15 * magnetR),
      regen: 0.5 * regen + 0.25 * regenR,
      cdMul: Math.pow(0.92, haste) * Math.pow(0.97, hasteR),
      dmgMul: 1 + 0.12 * power + 0.08 * powerR,
    };
  }

  /* -------------------------------------------------------------------- state */

  let state = 'menu';
  let game = null;
  let onScreen = true;
  const keys = { left: false, right: false, up: false, down: false };
  const joy = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };

  function newGame() {
    const g = {
      t: 0,
      kills: 0,
      shake: 0,
      player: { x: 0, y: 0, r: 15, hp: 100, maxHp: 100, inv: 0, face: 1, aimX: 1, aimY: 0, anim: 0, moving: false, level: 1, xp: 0, next: xpNeeded(1) },
      levels: { fetch: 1, bones: 0, bark: 0, comet: 0, speed: 0, suit: 0, magnet: 0, regen: 0, haste: 0, power: 0 },
      cd: { fetch: 0.4, bark: 1.5, comet: 1 },
      spawnTimer: 0.5,
      nextSwarm: 60,
      nextBoss: 120,
      bosses: 0,
      boneAngle: 0,
      bonePositions: [],
      pendingLevels: 0,
      enemies: [],
      balls: [],
      frisbees: [],
      waves: [],
      gems: [],
      particles: [],
      texts: [],
    };
    g.stats = derivedStats(g);
    return g;
  }

  /* ------------------------------------------------------------ spatial grid */

  const CELL = 64;
  const grid = new Map();
  const cellKey = (cx, cy) => ((cx & 0xffff) << 16) | (cy & 0xffff);

  function buildGrid(list) {
    grid.clear();
    for (const e of list) {
      const k = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      bucket.push(e);
    }
  }

  function queryGrid(x, y, radius, fn) {
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const y0 = Math.floor((y - radius) / CELL);
    const y1 = Math.floor((y + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (bucket) for (const e of bucket) fn(e);
      }
    }
  }

  /* ---------------------------------------------------------------- spawning */

  function spawnPoint(g) {
    const p = g.player;
    const a = rand(0, TAU);
    const d = Math.hypot(viewW, viewH) / 2 + 50;
    return [p.x + Math.cos(a) * d, p.y + Math.sin(a) * d];
  }

  function spawnEnemy(g, type, x, y) {
    const def = ENEMY_TYPES[type];
    // Past 5 minutes health grows faster than linearly so mastery ranks stay matched.
    const late = Math.max(0, (g.t - 300) / 150);
    const scale = type === 'boss' ? (1 + g.bosses * 0.9) * (1 + late) : 1 + g.t / 150 + late ** 1.5;
    const elite = type !== 'boss' && Math.random() < Math.min(0.25, Math.max(0, (g.t - 240) / 1200));
    const k = elite ? 3 : 1;
    g.enemies.push({
      type, x, y,
      elite,
      r: def.r * (elite ? 1.2 : 1),
      hp: def.hp * scale * k,
      maxHp: def.hp * scale * k,
      speed: def.speed * (1 + Math.min(0.25, g.t / 800)) * rand(0.9, 1.1),
      dmg: def.dmg * (elite ? 1.5 : 1),
      xp: def.xp * k,
      kx: 0, ky: 0,
      flash: 0,
      face: 1,
      phase: rand(0, TAU),
      boneCd: 0,
      frisCd: 0,
      dead: false,
    });
  }

  function pickType(t) {
    const weights = [
      ['squirrel', 60],
      ['bird', 25 + Math.min(25, t / 6)],
      ['raccoon', t > 45 ? 8 + t / 12 : 0],
      ['goose', t > 100 ? 3 + t / 30 : 0],
    ];
    let total = 0;
    for (const [, w] of weights) total += w;
    let r = Math.random() * total;
    for (const [type, w] of weights) if ((r -= w) < 0) return type;
    return 'squirrel';
  }

  // How many enemies may be alive at once; grows slowly so late game stays survivable.
  const activeCap = (g) => Math.min(MAX_ENEMIES, Math.floor(40 + g.t * 0.4));

  function updateSpawns(g, dt) {
    g.spawnTimer -= dt;
    if (g.spawnTimer <= 0) {
      g.spawnTimer = Math.max(0.35, 1.1 - g.t / 240);
      const n = 1 + Math.floor(g.t / 90);
      for (let i = 0; i < n && g.enemies.length < activeCap(g); i++) {
        const [x, y] = spawnPoint(g);
        spawnEnemy(g, pickType(g.t), x, y);
      }
    }
    if (g.t >= g.nextSwarm) {
      g.nextSwarm += 60;
      spawnSwarm(g);
    }
    if (g.t >= g.nextBoss) {
      g.nextBoss += 120;
      const [x, y] = spawnPoint(g);
      spawnEnemy(g, 'boss', x, y);
      g.bosses++;
      toast('⚠ The Nut Overlord approaches!');
    }
  }

  function spawnSwarm(g) {
    const p = g.player;
    const n = Math.min(40, 12 + Math.floor(g.t / 10));
    const R = Math.hypot(viewW, viewH) / 2 + 30;
    const type = g.t < 100 || Math.random() < 0.5 ? 'squirrel' : 'bird';
    for (let i = 0; i < n && g.enemies.length < activeCap(g) + n; i++) {
      const a = (i / n) * TAU;
      spawnEnemy(g, type, p.x + Math.cos(a) * R, p.y + Math.sin(a) * R);
    }
    toast(type === 'bird' ? 'A flock of space pigeons surrounds you!' : 'Squirrel swarm incoming!');
  }

  /* ----------------------------------------------------------------- combat */

  function hitEnemy(e, base, kx, ky) {
    const g = game;
    const dmg = base * g.stats.dmgMul;
    e.hp -= dmg;
    e.flash = 0.08;
    const kb = e.type === 'boss' ? 0.05 : 1;
    e.kx += kx * kb;
    e.ky += ky * kb;
    addText(g, e.x, e.y - e.r - 4, Math.round(dmg));
    if (e.hp <= 0) killEnemy(g, e);
  }

  function killEnemy(g, e) {
    e.dead = true;
    g.kills++;
    const color = ENEMY_TYPES[e.type].color;
    if (e.type === 'boss') {
      burst(g, e.x, e.y, color, 60, 320);
      for (let i = 0; i < 24; i++) dropGem(g, e.x + rand(-40, 40), e.y + rand(-40, 40), 4);
      heal(g, 40);
      g.shake = 16;
      toast('The Nut Overlord is defeated! 🥜');
    } else {
      burst(g, e.x, e.y, color, 8, 150);
      dropGem(g, e.x, e.y, e.xp);
    }
  }

  function damagePlayer(g, dmg) {
    const p = g.player;
    p.hp -= dmg;
    p.inv = 0.55;
    g.shake = Math.max(g.shake, 7);
    burst(g, p.x, p.y, '#ff6b8a', 8, 160);
    shell.classList.add('is-hurt');
    clearTimeout(damagePlayer.timer);
    damagePlayer.timer = setTimeout(() => shell.classList.remove('is-hurt'), 160);
  }

  function heal(g, n) {
    const p = g.player;
    p.hp = Math.min(p.maxHp, p.hp + n);
  }

  function dropGem(g, x, y, v) {
    if (g.gems.length >= MAX_GEMS) {
      g.gems[(Math.random() * g.gems.length) | 0].v += v;
      return;
    }
    g.gems.push({ x, y, v, sp: 0, pull: false, bob: rand(0, TAU), taken: false });
  }

  function gainXp(g, v) {
    const p = g.player;
    p.xp += v;
    while (p.xp >= p.next) {
      p.xp -= p.next;
      p.level++;
      p.next = xpNeeded(p.level);
      g.pendingLevels++;
    }
  }

  function burst(g, x, y, color, n, speed) {
    for (let i = 0; i < n && g.particles.length < MAX_PARTICLES; i++) {
      const a = rand(0, TAU);
      const s = rand(0.3, 1) * speed;
      const life = rand(0.3, 0.6);
      g.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, size: rand(1.5, 3.5), color });
    }
  }

  function addText(g, x, y, v) {
    if (g.texts.length >= MAX_TEXTS) g.texts.shift();
    g.texts.push({ x: x + rand(-6, 6), y, v, life: 0.6 });
  }

  function nearestEnemies(g, n, range) {
    const p = g.player;
    const r2 = range * range;
    const list = [];
    for (const e of g.enemies) {
      if (e.dead) continue;
      const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d < r2) list.push([d, e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    return list.slice(0, n).map((entry) => entry[1]);
  }

  /* ------------------------------------------------------------------ update */

  function update(dt) {
    const g = game;
    const p = g.player;
    g.t += dt;
    g.shake = Math.max(0, g.shake - dt * 30);

    let ix = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    let iy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (joy.active) {
      const dx = joy.x - joy.ox;
      const dy = joy.y - joy.oy;
      const len = Math.hypot(dx, dy);
      if (len > 6) {
        const m = Math.min(1, len / JOY_RADIUS);
        ix = (dx / len) * m;
        iy = (dy / len) * m;
      }
    }
    const il = Math.hypot(ix, iy);
    if (il > 1) {
      ix /= il;
      iy /= il;
    }
    p.moving = il > 0.1;
    if (p.moving) {
      p.x += ix * g.stats.speed * dt;
      p.y += iy * g.stats.speed * dt;
      const n = Math.hypot(ix, iy);
      p.aimX = ix / n;
      p.aimY = iy / n;
      if (Math.abs(ix) > 0.1) p.face = ix > 0 ? 1 : -1;
    }
    p.anim += dt * (p.moving ? 14 : 3);
    p.inv = Math.max(0, p.inv - dt);
    if (g.stats.regen) heal(g, g.stats.regen * dt);

    updateSpawns(g, dt);
    buildGrid(g.enemies);
    updateWeapons(g, dt);
    updateEnemies(g, dt);
    updateGems(g, dt);
    updateEffects(g, dt);
    g.enemies = g.enemies.filter((e) => !e.dead);

    if (p.hp <= 0) {
      endRun();
      return;
    }
    if (g.pendingLevels > 0) openLevelUp();
  }

  function updateWeapons(g, dt) {
    const p = g.player;
    const L = g.levels;
    const S = g.stats;

    // Fetch Blaster: tennis balls at the nearest enemies.
    g.cd.fetch -= dt;
    if (g.cd.fetch <= 0) {
      const w = WEAPONS.fetch(L.fetch);
      const targets = nearestEnemies(g, w.count, 560);
      if (targets.length) {
        for (let i = 0; i < w.count; i++) {
          const target = targets[i % targets.length];
          let a = Math.atan2(target.y - p.y, target.x - p.x);
          if (i >= targets.length) a += (i - targets.length + 1) * 0.18 * (i % 2 ? 1 : -1);
          g.balls.push({ x: p.x, y: p.y, vx: Math.cos(a) * 460, vy: Math.sin(a) * 460, r: 5, dmg: w.dmg, pierce: w.pierce, life: 1.3, hit: new Set(), spin: 0 });
        }
        g.cd.fetch = w.cd * S.cdMul;
      } else {
        g.cd.fetch = 0.15;
      }
    }

    // Bone Orbit
    g.bonePositions.length = 0;
    if (L.bones) {
      const w = WEAPONS.bones(L.bones);
      g.boneAngle += w.spin * dt;
      for (let i = 0; i < w.count; i++) {
        const a = g.boneAngle + (i * TAU) / w.count;
        const bx = p.x + Math.cos(a) * w.radius;
        const by = p.y + Math.sin(a) * w.radius;
        g.bonePositions.push(bx, by, a);
        queryGrid(bx, by, 10 + MAX_R, (e) => {
          if (e.dead || e.boneCd > g.t) return;
          const dx = e.x - bx;
          const dy = e.y - by;
          if (dx * dx + dy * dy < (e.r + 9) ** 2) {
            e.boneCd = g.t + 0.45;
            const d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
            hitEnemy(e, w.dmg, ((e.x - p.x) / d) * 160, ((e.y - p.y) / d) * 160);
          }
        });
      }
    }

    // Sonic Bark
    if (L.bark) {
      g.cd.bark -= dt;
      if (g.cd.bark <= 0) {
        const w = WEAPONS.bark(L.bark);
        g.waves.push({ r: 10, max: w.radius, dmg: w.dmg, push: w.push, hit: new Set() });
        g.cd.bark = w.cd * S.cdMul;
      }
    }

    // Comet Frisbee
    if (L.comet) {
      g.cd.comet -= dt;
      if (g.cd.comet <= 0) {
        const w = WEAPONS.comet(L.comet);
        const base = Math.atan2(p.aimY, p.aimX);
        for (let i = 0; i < w.count; i++) {
          g.frisbees.push({ a: base + (i * TAU) / w.count, age: 0, dur: 1.15, range: w.range, dmg: w.dmg, x: p.x, y: p.y, trail: [] });
        }
        g.cd.comet = w.cd * S.cdMul;
      }
    }

    for (const b of g.balls) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      b.spin += dt * 20;
      if (b.life <= 0) continue;
      queryGrid(b.x, b.y, b.r + MAX_R, (e) => {
        if (b.life <= 0 || e.dead || b.hit.has(e)) return;
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        if (dx * dx + dy * dy < (e.r + b.r) ** 2) {
          b.hit.add(e);
          hitEnemy(e, b.dmg, b.vx * 0.25, b.vy * 0.25);
          if (b.pierce-- <= 0) b.life = 0;
        }
      });
    }
    g.balls = g.balls.filter((b) => b.life > 0);

    for (const f of g.frisbees) {
      f.age += dt;
      const u = Math.min(1, f.age / f.dur);
      const out = Math.sin(Math.PI * u) * f.range;
      const side = Math.sin(TAU * u) * f.range * 0.25;
      const ca = Math.cos(f.a);
      const sa = Math.sin(f.a);
      f.x = p.x + ca * out - sa * side;
      f.y = p.y + sa * out + ca * side;
      f.trail.push(f.x, f.y);
      if (f.trail.length > 16) f.trail.splice(0, 2);
      queryGrid(f.x, f.y, 10 + MAX_R, (e) => {
        if (e.dead || e.frisCd > g.t) return;
        const dx = e.x - f.x;
        const dy = e.y - f.y;
        if (dx * dx + dy * dy < (e.r + 10) ** 2) {
          e.frisCd = g.t + 0.3;
          hitEnemy(e, f.dmg, ca * 120, sa * 120);
        }
      });
    }
    g.frisbees = g.frisbees.filter((f) => f.age < f.dur);

    for (const w of g.waves) {
      w.r += (w.max / 0.4) * dt;
      for (const e of g.enemies) {
        if (e.dead || w.hit.has(e)) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d - e.r < w.r) {
          w.hit.add(e);
          hitEnemy(e, w.dmg, (dx / d) * w.push, (dy / d) * w.push);
        }
      }
    }
    g.waves = g.waves.filter((w) => w.r < w.max);
  }

  function updateEnemies(g, dt) {
    const p = g.player;
    const far = Math.hypot(viewW, viewH) * 0.75 + 260;
    const decay = Math.exp(-dt * 7);
    for (const e of g.enemies) {
      if (e.dead) continue;
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      // Stragglers left far behind re-enter from the edge of the screen.
      if (d > far && e.type !== 'boss') {
        [e.x, e.y] = spawnPoint(g);
        continue;
      }
      let mx = dx / d;
      let my = dy / d;
      if (e.type === 'bird') {
        const w = Math.sin(g.t * 5 + e.phase) * 0.7;
        const ox = -my * w;
        const oy = mx * w;
        mx += ox;
        my += oy;
      }
      e.x += (mx * e.speed + e.kx) * dt;
      e.y += (my * e.speed + e.ky) * dt;
      e.kx *= decay;
      e.ky *= decay;
      e.face = dx >= 0 ? 1 : -1;
      if (e.flash > 0) e.flash -= dt;

      queryGrid(e.x, e.y, e.r + MAX_R, (o) => {
        if (o === e || o.dead) return;
        const sx = e.x - o.x;
        const sy = e.y - o.y;
        const min = (e.r + o.r) * 0.85;
        const dd = sx * sx + sy * sy;
        if (dd < min * min && dd > 0.0001) {
          const dist = Math.sqrt(dd);
          const push = (min - dist) * (o.r / (e.r + o.r));
          e.x += (sx / dist) * push;
          e.y += (sy / dist) * push;
        }
      });

      if (p.inv <= 0 && d < e.r + p.r - 3) damagePlayer(g, e.dmg);
    }
  }

  function updateGems(g, dt) {
    const p = g.player;
    const magnet = g.stats.magnet;
    for (const gem of g.gems) {
      const dx = p.x - gem.x;
      const dy = p.y - gem.y;
      const d = Math.hypot(dx, dy) || 1;
      if (!gem.pull && d < magnet) {
        gem.pull = true;
        gem.sp = -80;
      }
      if (gem.pull) {
        gem.sp = Math.min(gem.sp + 1600 * dt, 1000);
        gem.x += (dx / d) * gem.sp * dt;
        gem.y += (dy / d) * gem.sp * dt;
      }
      if (d < p.r + 6) {
        gem.taken = true;
        gainXp(g, gem.v);
      }
    }
    g.gems = g.gems.filter((gem) => !gem.taken);
  }

  function updateEffects(g, dt) {
    const damp = Math.exp(-dt * 4);
    for (const pt of g.particles) {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= damp;
      pt.vy *= damp;
      pt.life -= dt;
    }
    g.particles = g.particles.filter((pt) => pt.life > 0);
    for (const t of g.texts) {
      t.y -= 32 * dt;
      t.life -= dt;
    }
    g.texts = g.texts.filter((t) => t.life > 0);
  }

  /* ----------------------------------------------------------- draw helpers */

  function fillCircle(x, y, r, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function fillEllipse(x, y, rx, ry, c) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    ctx.fill();
  }

  function fillPoly(c, ...pts) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
  }

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function helmet(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = 'rgba(160, 210, 255, 0.14)';
    ctx.fill();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = 'rgba(205, 232, 255, 0.75)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.72, -2.5, -1.8);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  /* ------------------------------------------------ characters (facing right) */

  function drawDog(x, y, face, anim, moving) {
    ctx.save();
    ctx.translate(x, y + Math.sin(anim * 0.5) * 1.5);
    ctx.scale(face, 1);

    if (moving) {
      const fl = 7 + Math.sin(anim * 2.3) * 3;
      fillPoly('#ff9f43', -20, -3, -22 - fl, 1, -20, 5);
      fillPoly('#fff3b0', -20, -1, -20 - fl * 0.55, 1, -20, 3);
    }
    ctx.fillStyle = '#a3acd9';
    roundRectPath(-21, -7, 9, 14, 3);
    ctx.fill();
    ctx.fillStyle = '#6b75a8';
    ctx.fillRect(-21, -2, 9, 2);

    ctx.save();
    ctx.translate(-11, -2);
    ctx.rotate(-0.5 + Math.sin(anim * 1.3) * 0.45);
    fillEllipse(0, -5, 3.2, 6, '#e39a4f');
    fillCircle(0, -9.5, 2.2, '#fbe3c4');
    ctx.restore();

    const step = moving ? Math.sin(anim) * 2.2 : 0;
    ctx.fillStyle = '#c97c3a';
    for (const [lx, o] of [[-9, step], [-4, -step], [4, -step], [9, step]]) {
      roundRectPath(lx - 2, 8 + o * 0.5, 4, 6, 2);
      ctx.fill();
    }

    fillEllipse(0, 3, 14, 9, '#e8a257');
    fillEllipse(2, 6.5, 9, 4.5, '#fbe3c4');
    fillCircle(6.5, 1, 1.8, '#ffd166');

    fillCircle(10, -8, 8.5, '#e8a257');
    fillPoly('#e8a257', 4, -13, 5, -21, 10, -15);
    fillPoly('#e8a257', 10, -15, 14, -22, 16, -13);
    fillPoly('#f4b9a0', 5.5, -14, 6, -18.5, 8.5, -15);
    fillPoly('#f4b9a0', 11.5, -15, 13.8, -19, 14.8, -14);
    fillEllipse(14.5, -5.5, 5.5, 4.5, '#fbe3c4');
    fillEllipse(17.5, -5, 4.3, 3.1, '#fbe3c4');
    fillCircle(21, -6.3, 1.9, '#2b1d14');
    fillCircle(12.8, -10.2, 1.7, '#1b1420');
    fillCircle(13.3, -10.8, 0.6, '#ffffff');
    fillCircle(11.5, -5.8, 1.7, 'rgba(255, 120, 140, 0.45)');
    helmet(10, -9, 14.5);
    ctx.restore();
  }

  function drawSquirrel(t, withHelmet = true) {
    ctx.save();
    ctx.translate(-4, 4);
    ctx.rotate(Math.sin(t * 6) * 0.12);
    ctx.fillStyle = '#b5652a';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-16, -1, -17, -20, -5, -22);
    ctx.bezierCurveTo(2, -23, 2, -15, -3, -14);
    ctx.bezierCurveTo(-9, -12, -8, -4, 3, -2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    fillEllipse(0, 3, 7.5, 7, '#d4843f');
    fillEllipse(2, 5, 4, 4.5, '#f3d3a6');
    fillEllipse(-2, 10, 2.4, 1.6, '#a8591f');
    fillEllipse(4, 10, 2.4, 1.6, '#a8591f');
    fillCircle(5, -5, 5.5, '#d4843f');
    fillPoly('#d4843f', 1.5, -8, 2.5, -14, 6, -9.5);
    fillCircle(7.2, -6, 1.3, '#23160f');
    fillCircle(10.4, -4.4, 1, '#3a2215');
    fillCircle(7.5, -2.8, 1.6, 'rgba(255, 150, 140, 0.5)');
    if (withHelmet) {
      helmet(5, -5, 8.8);
      ctx.strokeStyle = 'rgba(205, 232, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(5, -13.8);
      ctx.lineTo(7, -18);
      ctx.stroke();
      fillCircle(7, -18.5, 1.6, Math.sin(t * 6) > 0 ? '#ff5d8f' : '#ffd166');
    }
  }

  function drawBird(t) {
    fillPoly('#5f72c4', -7, 0, -15, -4, -14, 4);
    fillEllipse(0, 0, 9, 7, '#8ea2e8');
    fillEllipse(2, 2.5, 5, 3.8, '#cfd8ff');
    ctx.save();
    ctx.translate(-1, -2);
    ctx.rotate(-0.5 + Math.sin(t * 18) * 0.8);
    fillEllipse(-5, 0, 7, 3.2, '#5f72c4');
    ctx.restore();
    fillCircle(7, -4, 4.6, '#8ea2e8');
    fillPoly('#ffb13b', 10.8, -5.2, 15.5, -3.6, 10.8, -2.4);
    fillCircle(8.2, -5, 1.2, '#1b1420');
    helmet(7, -4, 7.4);
  }

  function drawRaccoon(t) {
    ctx.save();
    ctx.translate(-10, 2);
    ctx.rotate(-0.5 + Math.sin(t * 5) * 0.15);
    for (let i = 3; i >= 0; i--) fillCircle(-i * 4, -i * 1.2, 4.2 - i * 0.2, i % 2 ? '#4a4e5a' : '#9ca1b0');
    ctx.restore();
    fillEllipse(0, 3, 12, 9, '#8a8f9e');
    fillEllipse(2, 6, 7, 5, '#c6c9d4');
    fillEllipse(-6, 12, 3, 2, '#5a5e6b');
    fillEllipse(6, 12, 3, 2, '#5a5e6b');
    fillCircle(4, -12, 3, '#6e7382');
    fillCircle(13, -13, 3, '#6e7382');
    fillCircle(9, -6, 8, '#9ca1b0');
    fillEllipse(11, -7, 7, 2.8, '#2d2f38');
    fillCircle(13, -7.2, 1.7, '#ffffff');
    fillCircle(13.4, -7.2, 0.9, '#111111');
    fillEllipse(15.5, -3.6, 3.6, 2.6, '#e8e9ef');
    fillCircle(18.6, -4.2, 1.4, '#222222');
    helmet(9, -6, 12);
  }

  function drawGoose(t) {
    fillPoly('#d5d7e3', -12, 2, -20, -2, -18, 6);
    fillEllipse(-2, 4, 13, 9, '#f2f2f7');
    ctx.save();
    ctx.translate(-4, 2);
    ctx.rotate(Math.sin(t * 8) * 0.15);
    fillEllipse(0, 0, 8, 5, '#d5d7e3');
    ctx.restore();
    ctx.strokeStyle = '#f2f2f7';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.quadraticCurveTo(13, -7, 9, -14);
    ctx.stroke();
    fillCircle(9, -16, 5.5, '#f2f2f7');
    fillPoly('#ff8c1a', 13, -17.5, 20.5, -15.5, 13, -13.2);
    fillCircle(10.8, -17.2, 1.2, '#1b1420');
    ctx.strokeStyle = '#1b1420';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(8.2, -20.5);
    ctx.lineTo(12.8, -18.6);
    ctx.stroke();
    fillEllipse(-4, 13, 2.8, 1.6, '#ff8c1a');
    fillEllipse(3, 13, 2.8, 1.6, '#ff8c1a');
    helmet(10, -16, 9);
  }

  function drawBoss(e, t) {
    ctx.translate(0, Math.sin(t * 2) * 3);

    const beam = ctx.createLinearGradient(0, 8, 0, 60);
    beam.addColorStop(0, 'rgba(255, 209, 102, 0.28)');
    beam.addColorStop(1, 'rgba(255, 209, 102, 0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(-18, 8);
    ctx.lineTo(18, 8);
    ctx.lineTo(34, 60);
    ctx.lineTo(-34, 60);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(150, 200, 255, 0.18)';
    ctx.beginPath();
    ctx.arc(0, -4, 24, Math.PI, 0);
    ctx.fill();

    // The pilot, crowned and clipped to the dome.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, -4, 23, Math.PI, 0);
    ctx.clip();
    ctx.translate(-6 * e.face, 0);
    ctx.scale(1.4 * e.face, 1.4);
    drawSquirrel(t, false);
    fillPoly('#ffd166', 1, -10, 2, -16, 4, -12.5, 6, -17, 8, -12.5, 10, -16, 10, -10);
    ctx.restore();

    ctx.strokeStyle = 'rgba(205, 232, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -4, 24, Math.PI, 0);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(0, -4, 18, -2.6, -1.9);
    ctx.stroke();

    const hull = ctx.createLinearGradient(0, -8, 0, 16);
    hull.addColorStop(0, '#dfe4ff');
    hull.addColorStop(0.5, '#8b93c9');
    hull.addColorStop(1, '#474e82');
    fillEllipse(0, 4, 48, 13, hull);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 1, 44, 8, 0, 0, Math.PI);
    ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const on = Math.floor(t * 6 + i) % 2 === 0;
      fillCircle(-33 + i * 11, 7, 2.6, on ? '#ffd166' : '#ff5d8f');
    }
    if (e.flash > 0) fillEllipse(0, 0, 48, 26, 'rgba(255, 255, 255, 0.45)');

    const w = 90;
    const pct = Math.max(0, e.hp / e.maxHp);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    roundRectPath(-w / 2, -44, w, 7, 3.5);
    ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = '#ff5d7a';
      roundRectPath(-w / 2, -44, w * pct, 7, 3.5);
      ctx.fill();
    }
  }

  const DRAW = { squirrel: drawSquirrel, bird: drawBird, raccoon: drawRaccoon, goose: drawGoose };

  function drawEnemy(e, t) {
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.type === 'boss') {
      drawBoss(e, t);
    } else {
      if (e.elite) {
        ctx.globalAlpha = 0.22 + 0.08 * Math.sin(t * 6 + e.phase);
        fillCircle(0, -2, e.r * 1.35, '#ffd166');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255, 209, 102, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, -2, e.r * 1.35, 0, TAU);
        ctx.stroke();
      }
      ctx.scale(e.face * (e.elite ? 1.2 : 1), e.elite ? 1.2 : 1);
      ctx.translate(0, Math.sin(t * 10 + e.phase) * 1.2);
      DRAW[e.type](t + e.phase);
      if (e.flash > 0) fillCircle(0, -2, e.r * 1.05, 'rgba(255, 255, 255, 0.6)');
    }
    ctx.restore();
  }

  /* ----------------------------------------------------------------- effects */

  function drawGem(gem, t) {
    const c = gem.v >= 20 ? '#ff7ad9' : gem.v >= 8 ? '#ffd166' : gem.v >= 3 ? '#7dff9a' : '#6ee7ff';
    const s = 4 + Math.min(4, Math.log2(gem.v + 1));
    const k = s * 0.35;
    ctx.save();
    ctx.translate(gem.x, gem.y + Math.sin(t * 4 + gem.bob) * 1.5);
    ctx.globalAlpha = 0.25;
    fillCircle(0, 0, s * 1.8, c);
    ctx.globalAlpha = 1;
    fillPoly(c, 0, -s, k, -k, s, 0, k, k, 0, s, -k, k, -s, 0, -k, -k);
    ctx.restore();
  }

  function drawBone(x, y, a) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a * 3);
    ctx.globalAlpha = 0.18;
    fillCircle(0, 0, 12, '#fff3d6');
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#f5efe2';
    ctx.fillRect(-6, -2, 12, 4);
    fillCircle(-6, -2.4, 2.8, '#f5efe2');
    fillCircle(-6, 2.4, 2.8, '#f5efe2');
    fillCircle(6, -2.4, 2.8, '#f5efe2');
    fillCircle(6, 2.4, 2.8, '#f5efe2');
    ctx.restore();
  }

  function drawFrisbee(f) {
    const n = f.trail.length / 2;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      fillCircle(f.trail[i * 2], f.trail[i * 2 + 1], 3 + 5 * k, `rgba(255, 111, 181, ${0.35 * k})`);
    }
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.age * 20);
    fillCircle(0, 0, 8.5, '#ff6fb5');
    ctx.strokeStyle = '#ffd1e8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, TAU);
    ctx.stroke();
    fillCircle(0, 0, 2, '#ffd1e8');
    ctx.restore();
  }

  function drawBall(b) {
    ctx.globalAlpha = 0.35;
    fillCircle(b.x - b.vx * 0.02, b.y - b.vy * 0.02, 4, '#d8f24a');
    ctx.globalAlpha = 1;
    fillCircle(b.x, b.y, 5, '#d8f24a');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3.2, b.spin, b.spin + 2.2);
    ctx.stroke();
  }

  function drawWave(x, y, w) {
    const a = 1 - w.r / w.max;
    ctx.strokeStyle = `rgba(140, 205, 255, ${0.7 * a})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, w.r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 * a})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, w.r * 0.85, 0, TAU);
    ctx.stroke();
  }

  /* -------------------------------------------------------------- background */

  const STAR_LAYERS = [
    { factor: 0.15, tile: 900, count: 90, size: [0.4, 1.1], alpha: [0.25, 0.6] },
    { factor: 0.4, tile: 700, count: 45, size: [0.8, 1.6], alpha: [0.4, 0.8] },
    { factor: 0.8, tile: 600, count: 18, size: [1.2, 2.2], alpha: [0.6, 1] },
  ].map((layer) => ({
    ...layer,
    stars: Array.from({ length: layer.count }, () => ({
      x: rand(0, layer.tile),
      y: rand(0, layer.tile),
      r: rand(...layer.size),
      a: rand(...layer.alpha),
      tw: rand(0, TAU),
      color: Math.random() < 0.15 ? (Math.random() < 0.5 ? '#ffd6a5' : '#a5c8ff') : '#ffffff',
    })),
  }));

  const PLANET_TILE = 2000;
  const PLANET_FACTOR = 0.08;
  const PLANETS = [
    { x: 260, y: 180, r: 70, c1: '#ff9f6b', c2: '#7a2f5c', ring: true },
    { x: 1500, y: 1100, r: 44, c1: '#7ee0c3', c2: '#1d4a6b', ring: false },
    { x: 1100, y: 420, r: 18, c1: '#e6e3ff', c2: '#6a64a8', ring: false },
  ];

  function drawPlanet(x, y, p) {
    if (p.ring) {
      ctx.strokeStyle = 'rgba(255, 210, 170, 0.35)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(x, y, p.r * 1.7, p.r * 0.45, -0.35, Math.PI, TAU);
      ctx.stroke();
    }
    const grad = ctx.createRadialGradient(x - p.r * 0.4, y - p.r * 0.4, p.r * 0.1, x, y, p.r);
    grad.addColorStop(0, p.c1);
    grad.addColorStop(1, p.c2);
    fillCircle(x, y, p.r, grad);
    if (p.ring) {
      ctx.beginPath();
      ctx.ellipse(x, y, p.r * 1.7, p.r * 0.45, -0.35, 0, Math.PI);
      ctx.stroke();
    }
  }

  function drawBackground(camX, camY, time) {
    const sky = ctx.createLinearGradient(0, 0, 0, vh);
    sky.addColorStop(0, '#0a0c1f');
    sky.addColorStop(1, '#120a24');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, vw, vh);

    const neb = ctx.createRadialGradient(vw * 0.2, vh * 0.25, 0, vw * 0.2, vh * 0.25, Math.max(vw, vh) * 0.6);
    neb.addColorStop(0, 'rgba(124, 92, 255, 0.16)');
    neb.addColorStop(1, 'rgba(124, 92, 255, 0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, vw, vh);
    const neb2 = ctx.createRadialGradient(vw * 0.85, vh * 0.8, 0, vw * 0.85, vh * 0.8, Math.max(vw, vh) * 0.5);
    neb2.addColorStop(0, 'rgba(236, 72, 153, 0.1)');
    neb2.addColorStop(1, 'rgba(236, 72, 153, 0)');
    ctx.fillStyle = neb2;
    ctx.fillRect(0, 0, vw, vh);

    const pox = mod(-camX * PLANET_FACTOR, PLANET_TILE);
    const poy = mod(-camY * PLANET_FACTOR, PLANET_TILE);
    for (const p of PLANETS) {
      for (let tx = pox - PLANET_TILE; tx < vw + p.r * 2; tx += PLANET_TILE) {
        for (let ty = poy - PLANET_TILE; ty < vh + p.r * 2; ty += PLANET_TILE) {
          const x = tx + p.x;
          const y = ty + p.y;
          if (x > -p.r * 2 && x < vw + p.r * 2 && y > -p.r * 2 && y < vh + p.r * 2) drawPlanet(x, y, p);
        }
      }
    }

    const twinkle = !reducedMotion.matches;
    for (const layer of STAR_LAYERS) {
      const ox = mod(-camX * layer.factor, layer.tile);
      const oy = mod(-camY * layer.factor, layer.tile);
      for (let tx = ox - layer.tile; tx < vw; tx += layer.tile) {
        for (let ty = oy - layer.tile; ty < vh; ty += layer.tile) {
          for (const s of layer.stars) {
            const x = tx + s.x;
            const y = ty + s.y;
            if (x < -3 || x > vw + 3 || y < -3 || y > vh + 3) continue;
            ctx.globalAlpha = twinkle ? s.a * (0.7 + 0.3 * Math.sin(time * 2 + s.tw)) : s.a;
            ctx.fillStyle = s.color;
            ctx.fillRect(x - s.r, y - s.r, s.r * 2, s.r * 2);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------------ render */

  function renderMenu(time) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(time * 30, Math.sin(time * 0.25) * 60, time);
    // A little chase scene looping around the briefing panel.
    const cx = vw / 2;
    const cy = vh / 2;
    const rx = vw * 0.4;
    const ry = vh * 0.38;
    const cast = [null, 'squirrel', 'bird', 'squirrel', 'raccoon', 'goose'];
    cast.forEach((type, k) => {
      const a = time * 0.45 - k * 0.3;
      const x = cx + Math.cos(a) * rx;
      const y = cy + Math.sin(a) * ry;
      const face = -Math.sin(a) >= 0 ? 1 : -1;
      if (!type) {
        drawDog(x, y, face, time * 14, true);
      } else {
        ctx.save();
        ctx.translate(x, y + Math.sin(time * 10 + k) * 1.2);
        ctx.scale(face, 1);
        DRAW[type](time + k);
        ctx.restore();
      }
    });
  }

  function render(time) {
    const g = game;
    const p = g.player;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const shake = reducedMotion.matches ? 0 : g.shake;
    const sx = shake ? rand(-shake, shake) : 0;
    const sy = shake ? rand(-shake, shake) : 0;
    const camX = p.x - viewW / 2;
    const camY = p.y - viewH / 2;
    drawBackground(camX, camY, time);

    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-camX + sx, -camY + sy);
    const inView = (x, y, m) => x > camX - m && x < camX + viewW + m && y > camY - m && y < camY + viewH + m;

    for (const gem of g.gems) if (inView(gem.x, gem.y, 20)) drawGem(gem, time);
    for (const w of g.waves) drawWave(p.x, p.y, w);
    let boss = null;
    for (const e of g.enemies) {
      if (e.type === 'boss') boss = e;
      else if (inView(e.x, e.y, 40)) drawEnemy(e, time);
    }
    if (boss && inView(boss.x, boss.y, 80)) drawEnemy(boss, time);
    for (let i = 0; i < g.bonePositions.length; i += 3) drawBone(g.bonePositions[i], g.bonePositions[i + 1], g.bonePositions[i + 2]);
    for (const b of g.balls) drawBall(b);
    for (const f of g.frisbees) drawFrisbee(f);

    if (p.inv > 0 && Math.floor(time * 24) % 2) ctx.globalAlpha = 0.45;
    drawDog(p.x, p.y, p.face, p.anim, p.moving);
    ctx.globalAlpha = 1;

    for (const pt of g.particles) {
      ctx.globalAlpha = pt.life / pt.max;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;

    ctx.font = '600 12px "Lexend Deca", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const t of g.texts) {
      ctx.globalAlpha = Math.min(1, t.life / 0.3);
      ctx.strokeStyle = 'rgba(10, 10, 30, 0.8)';
      ctx.strokeText(t.v, t.x, t.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(t.v, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Point toward an off-screen boss.
    if (boss && !inView(boss.x, boss.y, -20)) {
      const a = Math.atan2(boss.y - p.y, boss.x - p.x);
      ctx.save();
      ctx.translate(vw / 2 + Math.cos(a) * (vw / 2 - 28), vh / 2 + Math.sin(a) * (vh / 2 - 28));
      ctx.rotate(a);
      fillPoly('#ffd166', 12, 0, -6, -9, -6, 9);
      ctx.restore();
    }

    if (joy.active) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(joy.ox, joy.oy, JOY_RADIUS, 0, TAU);
      ctx.stroke();
      const dx = joy.x - joy.ox;
      const dy = joy.y - joy.oy;
      const len = Math.hypot(dx, dy) || 1;
      const m = Math.min(len, JOY_RADIUS);
      fillCircle(joy.ox + (dx / len) * m, joy.oy + (dy / len) * m, 16, 'rgba(255, 255, 255, 0.3)');
    }
  }

  /* --------------------------------------------------------------------- UI */

  function setText(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  function updateHud() {
    const p = game.player;
    ui.hpFill.style.transform = `scaleX(${clamp(p.hp / p.maxHp, 0, 1)})`;
    ui.xpFill.style.transform = `scaleX(${clamp(p.xp / p.next, 0, 1)})`;
    setText(ui.hpText, `${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`);
    setText(ui.level, `LV ${p.level}`);
    setText(ui.time, fmtTime(game.t));
    setText(ui.kills, String(game.kills));
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => ui.toast.classList.remove('is-visible'), 2600);
  }

  function focusEl(el) {
    if (el) el.focus({ preventScroll: true });
  }

  function setState(next) {
    state = next;
    shell.dataset.state = next;
    for (const [name, el] of Object.entries(overlays)) el.hidden = name !== next;
    if (next !== 'playing') {
      joy.active = false;
      for (const k in keys) keys[k] = false;
    }
  }

  function startRun() {
    game = newGame();
    ui.toast.classList.remove('is-visible');
    setState('playing');
    updateHud();
    focusEl(canvas);
  }

  function pause() {
    if (state !== 'playing') return;
    setState('paused');
    focusEl(overlays.paused.querySelector('[data-action="resume"]'));
  }

  function resume() {
    if (state !== 'paused') return;
    setState('playing');
    focusEl(canvas);
  }

  function offerUpgrades(g) {
    // Regular levels are three times as likely to show up as mastery ranks.
    const pool = UPGRADES.filter((u) => g.levels[u.id] < u.max + u.ranks).map((u) => ({ u, w: g.levels[u.id] < u.max ? 3 : 1 }));
    const picks = [];
    while (picks.length < 3 && pool.length) {
      let r = Math.random() * pool.reduce((sum, o) => sum + o.w, 0);
      const i = pool.findIndex((o) => (r -= o.w) < 0);
      picks.push(pool.splice(i < 0 ? pool.length - 1 : i, 1)[0].u);
    }
    // A snack only fills an empty slot, and only when Comet is actually hurt.
    if (picks.length < 3 && g.player.hp < g.player.maxHp) picks.push(TREAT);
    return picks;
  }

  function choiceCard(u, i, g) {
    const current = g.levels[u.id] || 0;
    const next = current + 1;
    const rank = u === TREAT ? 0 : next - u.max;
    const tag = u === TREAT ? 'Snack' : current === 0 ? 'New!' : rank > 0 ? `★ Mastery ${rank}` : `Lv ${next}`;
    const desc = rank > 0 ? u.mastery(rank) : u.text(next);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = rank > 0 ? 'choice choice--mastery' : 'choice';
    btn.innerHTML =
      `<span class="choice-key" aria-hidden="true">${i + 1}</span>` +
      `<span class="choice-icon" aria-hidden="true">${u.icon}</span>` +
      `<span class="choice-name">${u.name}</span>` +
      `<span class="choice-tag">${tag}</span>` +
      `<span class="choice-desc">${desc}</span>`;
    btn.addEventListener('click', () => choose(u.id));
    return btn;
  }

  function openLevelUp() {
    const g = game;
    const picks = offerUpgrades(g);
    // Nothing left to choose: top up health without interrupting the run.
    if (!picks.length || (picks.length === 1 && picks[0] === TREAT)) {
      const healed = Math.min(40, g.player.maxHp - g.player.hp);
      heal(g, 40);
      g.pendingLevels--;
      if (healed > 0) toast(`Level ${g.player.level - g.pendingLevels}! +${Math.round(healed)} HP`);
      if (g.pendingLevels > 0) openLevelUp();
      else if (state !== 'playing') setState('playing');
      return;
    }
    setState('levelup');
    ui.levelTitle.textContent = `Level ${g.player.level - g.pendingLevels + 1}!`;
    ui.choices.replaceChildren(...picks.map((u, i) => choiceCard(u, i, g)));
    focusEl(ui.choices.firstElementChild);
  }

  function choose(id) {
    const g = game;
    if (state !== 'levelup') return;
    if (id === 'treat') {
      heal(g, 40);
    } else {
      g.levels[id]++;
      if (id === 'suit') {
        const bonus = g.levels.suit > UPGRADE_BY_ID.suit.max ? 10 : 20;
        g.player.maxHp += bonus;
        heal(g, bonus);
      }
      g.stats = derivedStats(g);
    }
    g.pendingLevels--;
    if (g.pendingLevels > 0) {
      openLevelUp();
    } else {
      setState('playing');
      focusEl(canvas);
    }
  }

  function readBest() {
    return parseFloat(store.get(BEST_KEY)) || 0;
  }

  function showBestOnMenu() {
    const best = readBest();
    ui.bestStart.hidden = best <= 0;
    if (best > 0) ui.bestStart.textContent = `Your best run: ${fmtTime(best)}`;
  }

  function endRun() {
    const g = game;
    const best = readBest();
    const isBest = g.t > best;
    if (isBest) store.set(BEST_KEY, g.t.toFixed(1));
    burst(g, g.player.x, g.player.y, '#e8a257', 30, 220);
    ui.resultTime.textContent = fmtTime(g.t);
    ui.resultKills.textContent = String(g.kills);
    ui.resultLevel.textContent = String(g.player.level);
    ui.resultBest.textContent = fmtTime(Math.max(best, g.t));
    ui.newBest.hidden = !isBest;
    setState('over');
    focusEl(overlays.over.querySelector('[data-action="restart"]'));
  }

  /* ------------------------------------------------------------------ input */

  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
  };

  window.addEventListener('keydown', (ev) => {
    const dir = KEYMAP[ev.code];
    if (dir && state === 'playing') {
      keys[dir] = true;
      ev.preventDefault();
      return;
    }
    if (ev.code === 'KeyP' || ev.code === 'Escape') {
      if (state === 'playing') {
        pause();
        ev.preventDefault();
      } else if (state === 'paused') {
        resume();
        ev.preventDefault();
      }
      return;
    }
    if (state === 'levelup' && /^(Digit|Numpad)[1-3]$/.test(ev.code)) {
      const btn = ui.choices.children[Number(ev.code.slice(-1)) - 1];
      if (btn) btn.click();
    }
  });

  window.addEventListener('keyup', (ev) => {
    const dir = KEYMAP[ev.code];
    if (dir) keys[dir] = false;
  });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  function pointerPos(ev) {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (state !== 'playing') return;
    const [x, y] = pointerPos(ev);
    Object.assign(joy, { active: true, id: ev.pointerId, ox: x, oy: y, x, y });
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!joy.active || ev.pointerId !== joy.id) return;
    [joy.x, joy.y] = pointerPos(ev);
  });

  const endPointer = (ev) => {
    if (ev.pointerId === joy.id) joy.active = false;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  shell.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'start' || action === 'restart') startRun();
    else if (action === 'resume') resume();
    else if (action === 'pause') pause();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      if (!onScreen) pause();
    },
    { threshold: 0.2 },
  ).observe(shell);

  /* ------------------------------------------------------------------- loop */

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (state === 'playing') update(dt);
    if (onScreen) {
      if (state === 'menu') renderMenu(now / 1000);
      else render(now / 1000);
    }
    if (game) updateHud();
    requestAnimationFrame(frame);
  }

  setState('menu');
  showBestOnMenu();
  requestAnimationFrame(frame);
})();
