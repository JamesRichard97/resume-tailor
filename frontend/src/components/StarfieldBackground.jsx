import { useEffect, useRef } from 'react'

import styles from './StarfieldBackground.module.css'

/**
 * Interactive starfield behind the whole app.
 *
 * Stars drift slowly and twinkle on their own; moving the pointer brightens the
 * ones near it and draws constellation lines between them, so the sky appears
 * to form around the cursor. Written from scratch — the behaviour is inspired
 * by Thibka's "Interactive Stars" canvas experiment, none of the code is.
 *
 * Deliberate constraints, because this is decoration and must never get in the
 * way of the actual app:
 *
 * * `pointer-events: none` — it can't intercept a click meant for a card.
 * * Honours `prefers-reduced-motion`: a still field, no animation loop at all.
 * * Stops when the tab is hidden, so a background tab costs nothing.
 * * Star count scales with the viewport and is capped, and the constellation
 *   pass only ever looks at the handful of stars near the cursor — so the
 *   per-frame cost stays flat rather than growing with the window.
 */

// Roughly one star per 6,500px²: ~200 on a laptop, ~330 on a large monitor.
// Sparser than this and the constellations have nothing to connect.
const DENSITY = 1 / 6500
const MAX_STARS = 340
const MIN_STARS = 70

// How far the cursor's influence reaches, and how close two lit stars have to
// be before a line is drawn between them.
const CURSOR_RADIUS = 260
const LINK_DISTANCE = 135

// Above this, a star counts as "lit" and joins the constellation pass.
const LIT_THRESHOLD = 0.12

const TAU = Math.PI * 2

const PALETTE = {
  dark: { base: 0.58, lineAlpha: 0.85 },
  light: { base: 0.42, lineAlpha: 0.6 },
}

/**
 * Star and line colour cycles.
 *
 * These run about three times faster than the sky, so the tint is the part you
 * actually notice changing while the sky underneath shifts so slowly it reads
 * as constant. Lines are the more saturated of the pair — they are the accent,
 * the stars are the field.
 *
 * Dark: near-whites with a hint of hue, so every step still reads as a star
 * rather than a coloured dot. Light: deep and saturated, because anything
 * paler would vanish into a near-white sky.
 */
const TINT = {
  dark: {
    star: ['#ffffff', '#ffe9c4', '#cdeeff', '#f3daff', '#d8fff0'],
    line: ['#8fb4ff', '#ffc98a', '#79e6d8', '#c3a0ff', '#ff9fc4'],
  },
  light: {
    star: ['#2e4274', '#1d5a58', '#553a78', '#7a4a2f', '#2b5a7a'],
    line: ['#5f7fbe', '#3f8f88', '#8a5fa8', '#b0724a', '#4f86ab'],
  },
}

// One sky pair lasts this long; the tint moves on at a third of it.
const SKY_PERIOD_MS = 26000
const TINT_PERIOD_MS = 8500

/**
 * The sky itself: a vertical gradient that drifts between these [top, bottom]
 * pairs and loops. Slow on purpose — a full pass takes a couple of minutes, so
 * you notice the colour has changed without ever catching it changing.
 *
 * The dark set stays in the blue-violet-teal range of a real night sky; the
 * light set is barely tinted, because a page you read all day should not be
 * washed in colour.
 */
const SKY = {
  dark: [
    ['#0c1226', '#090c15'],
    ['#140d27', '#0b0912'],
    ['#081c2b', '#080f18'],
    ['#0f1030', '#0a0b14'],
  ],
  light: [
    ['#eaf1fd', '#fbfcfe'],
    ['#f3edfc', '#fcfbfe'],
    ['#e8f6f3', '#f9fcfb'],
    ['#fdf0ea', '#fdfbf9'],
  ],
}

const rand = (min, max) => min + Math.random() * (max - min)

const hexToRGB = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** Eased blend between two hex colours, as an `r, g, b` string ready to drop
 *  into `rgb(...)` or `rgba(..., alpha)`. */
function blend(from, to, t) {
  // Smoothstep, so each colour lingers and the handover is not a linear ramp
  // with a visible kink at either end.
  const e = t * t * (3 - 2 * t)
  const a = hexToRGB(from)
  const b = hexToRGB(to)
  return a.map((v, i) => Math.round(v + (b[i] - v) * e)).join(', ')
}

/** Where `time` sits in a looping list: the two entries to blend, and how far
 *  between them. Frozen at the first entry when motion is reduced. */
function cycle(list, time, period, still) {
  if (still) return { from: list[0], to: list[0], t: 0 }
  const step = time / period
  const i = Math.floor(step) % list.length
  return {
    from: list[i],
    to: list[(i + 1) % list.length],
    t: step - Math.floor(step),
  }
}

export default function StarfieldBackground() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return undefined

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    let stars = []
    let width = 0
    let height = 0
    let frame = 0
    let running = true

    // Where the pointer is, and where the drawing "thinks" it is — eased, so
    // a fast flick of the mouse sweeps the constellations along instead of
    // teleporting them.
    const pointer = { x: 0, y: 0, active: false }
    const eased = { x: 0, y: 0, strength: 0 }

    function makeStars() {
      const target = Math.round(width * height * DENSITY)
      const count = Math.max(MIN_STARS, Math.min(MAX_STARS, target))
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: rand(0.4, 1.5),
        // Rising. Negative y is up, and the vertical component dominates so
        // the whole field reads as one slow drift toward the top rather than
        // as scattered wandering. Slow enough that it looks still until you
        // watch one star for a few seconds.
        vx: rand(-0.035, 0.035),
        vy: -rand(0.09, 0.34),
        phase: Math.random() * TAU,
        // Each star twinkles at its own rate, or the whole sky pulses together.
        twinkle: rand(0.4, 1.3),
        // Depth: dimmer stars also drift slower, which reads as distance.
        depth: rand(0.35, 1),
      }))
    }

    function resize() {
      // Cap the pixel ratio: on a 3x phone the extra pixels cost real frames
      // and buy nothing on a field of 1px dots.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      makeStars()
      if (reduceMotion.matches) draw(0)
    }

    function draw(time) {
      const isLight = document.documentElement.dataset.theme === 'light'
      const key = isLight ? 'light' : 'dark'
      const { base, lineAlpha } = PALETTE[key]
      const still = reduceMotion.matches

      // The sky. Opaque, so it replaces the page background rather than
      // sitting on top of it — which also saves clearing the canvas first.
      const sky = SKY[key]
      const skyStep = still ? 0 : time / SKY_PERIOD_MS
      const i = Math.floor(skyStep) % sky.length
      const next = (i + 1) % sky.length
      const skyT = skyStep - Math.floor(skyStep)

      const gradient = ctx.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, `rgb(${blend(sky[i][0], sky[next][0], skyT)})`)
      gradient.addColorStop(1, `rgb(${blend(sky[i][1], sky[next][1], skyT)})`)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)

      // Tint for this frame's stars and lines.
      const sc = cycle(TINT[key].star, time, TINT_PERIOD_MS, still)
      const lc = cycle(TINT[key].line, time, TINT_PERIOD_MS, still)
      const starRGB = blend(sc.from, sc.to, sc.t)
      const lineRGB = blend(lc.from, lc.to, lc.t)

      // Ease the cursor and its strength, so influence fades in and out rather
      // than snapping when the pointer enters or leaves the window.
      eased.x += (pointer.x - eased.x) * 0.08
      eased.y += (pointer.y - eased.y) * 0.08
      eased.strength += ((pointer.active ? 1 : 0) - eased.strength) * 0.05

      const lit = []

      for (const s of stars) {
        if (!reduceMotion.matches) {
          s.x += s.vx * s.depth
          s.y += s.vy * s.depth
          // A star that rises off the top comes back in at the bottom, at a
          // fresh x — reusing the same column would slowly carve visible
          // vertical tracks into the field.
          if (s.y < -2) {
            s.y = height + 2
            s.x = Math.random() * width
          }
          if (s.x < -2) s.x = width + 2
          else if (s.x > width + 2) s.x = -2
        }

        const twinkle = reduceMotion.matches
          ? 0.75
          : 0.6 + 0.4 * Math.sin(time * 0.001 * s.twinkle + s.phase)

        let near = 0
        if (eased.strength > 0.01) {
          const dx = s.x - eased.x
          const dy = s.y - eased.y
          const dist = Math.hypot(dx, dy)
          if (dist < CURSOR_RADIUS) {
            // Gentler than a squared falloff, which lit a tight core and left
            // too few stars in range for the lines to find each other.
            const t = 1 - dist / CURSOR_RADIUS
            near = t * Math.sqrt(t) * eased.strength
          }
        }

        const alpha = Math.min(1, base * s.depth * twinkle + near * 0.9)
        const radius = s.r * (1 + near * 0.8)

        ctx.beginPath()
        ctx.arc(s.x, s.y, radius, 0, TAU)
        ctx.fillStyle = `rgba(${starRGB}, ${alpha})`
        ctx.fill()

        if (near > LIT_THRESHOLD) lit.push({ x: s.x, y: s.y, near })
      }

      // Constellations. Only the lit stars take part, and there are rarely more
      // than ~30 of those, so this stays cheap however big the window gets.
      if (lit.length > 1) {
        ctx.lineWidth = 0.7
        for (let i = 0; i < lit.length; i += 1) {
          for (let j = i + 1; j < lit.length; j += 1) {
            const a = lit[i]
            const b = lit[j]
            const dist = Math.hypot(a.x - b.x, a.y - b.y)
            if (dist > LINK_DISTANCE) continue
            // Fades with the gap between the two stars and with how lit each
            // of them is, so lines dissolve at the edge of the cursor's reach
            // instead of ending abruptly.
            const strength = (1 - dist / LINK_DISTANCE) * Math.min(a.near, b.near)
            ctx.strokeStyle = `rgba(${lineRGB}, ${strength * lineAlpha})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
    }

    function loop(time) {
      if (!running) return
      draw(time)
      frame = requestAnimationFrame(loop)
    }

    function start() {
      if (reduceMotion.matches || frame) return
      running = true
      frame = requestAnimationFrame(loop)
    }

    function stop() {
      running = false
      cancelAnimationFrame(frame)
      frame = 0
    }

    const onPointerMove = (event) => {
      pointer.x = event.clientX
      pointer.y = event.clientY
      if (!pointer.active) {
        // First sighting: start the eased position at the pointer so the
        // constellation appears under it rather than flying in from 0,0.
        eased.x = pointer.x
        eased.y = pointer.y
      }
      pointer.active = true
    }
    const onPointerLeave = () => {
      pointer.active = false
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    const onMotionChange = () => {
      stop()
      if (reduceMotion.matches) draw(0)
      else start()
    }

    resize()
    start()

    window.addEventListener('resize', resize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)
    document.addEventListener('visibilitychange', onVisibility)
    reduceMotion.addEventListener('change', onMotionChange)

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      reduceMotion.removeEventListener('change', onMotionChange)
    }
  }, [])

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
}
