/* =============================================================================
   ServWave Design System - spacing vocabulary, FROZEN BASELINE.

   Three things are fenced here, and the second and third are the reason this
   file exists at all:

     1. BEHAVIOUR. padClasses' three branches and its precedence order, plus
        the invariant that the shorthand never appears alongside a per-side or
        per-axis override. A unit assertion catches all of that.

     2. THE LITERALS THEMSELVES. A typo in one of the 91 class names moves
        rendered geometry on every primitive built on this module at once, and
        it does it silently: Tailwind does not error on a class it cannot
        resolve, it emits nothing and exits 0. So the table below is written
        out BY HAND, 91 entries, and compared literally. An expectation
        assembled from a prefix and a step is a weaker fence, because it
        reproduces whatever assembly rule the module used and passes. Both
        checks are kept: the literal table catches a wrong value, the assembly
        check catches a value filed under the wrong key.

     3. LITERALNESS IN THE SOURCE. Tailwind's scanner reads source TEXT, so a
        class built by interpolation generates no CSS and the element silently
        renders with no padding. Nothing about the value at runtime reveals
        that: the string looks correct in every assertion above. So the source
        of spacing.ts is read back and every one of the 91 class names is
        required to be physically present in it as a quoted literal.

   ---------------------------------------------------------------------------
   ONE DIVERGENCE FROM THE WRITTEN BRIEF, RECORDED HERE ON PURPOSE
   ---------------------------------------------------------------------------
   The brief for this file asked that `padClasses({ padTop: 2, padX: 4 })`
   "names all four sides explicitly". The shipped module names three, because
   the bottom side has no per-side value, no axis value and no uniform value to
   resolve from, and synthesising a step-0 class for it is NOT a no-op:
   padding is not universally zeroed by the preflight reset, so a zero on a
   table cell or a list would remove padding a user-agent stylesheet supplies.
   That is a rendered change, which this session forbids outright. The module
   documents the same reasoning at spacing.ts:226.

   The brief's clause is still asserted, in the case where it is not vacuous:
   when a uniform or axis value IS present, all four sides are named and the
   per-side value wins on its own side. See "the brief's four-sided case"
   below. The three-token shape is asserted separately as the tab-rail case.
   Flagged rather than quietly resolved, so a reviewer can overturn it.
   ============================================================================= */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PAD,
  PAD_BOTTOM,
  PAD_LEFT,
  PAD_RIGHT,
  PAD_STEPS,
  PAD_TOP,
  PAD_X,
  PAD_Y,
  padClasses,
  type PadStep,
} from '../spacing'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(resolve(HERE, '..', 'spacing.ts'), 'utf8')

/** The ladder the vocabulary settled on, before this session's amendment. */
const SETTLED_STEPS: readonly PadStep[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12]

/** The ladder after the amendment, written out rather than derived. */
const STEPS: readonly PadStep[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]

/**
 * Compile-time proof that the added step is in the PadStep union. If 10 lands
 * in the runtime maps but not in the type, this line fails tsc even though
 * every runtime assertion below would still pass.
 */
const TEN: PadStep = 10

/**
 * THE FROZEN BASELINE. 7 maps x 13 steps = 91 class names, typed out one by
 * one. Do NOT refactor this into a loop over a prefix list: the entire value
 * of this table is that it was written independently of the module, so a typo
 * in one cannot be reproduced by the other.
 */
const FROZEN: Record<string, Record<PadStep, string>> = {
  PAD: {
    0: 'p-0',
    0.5: 'p-0.5',
    1: 'p-1',
    1.5: 'p-1.5',
    2: 'p-2',
    2.5: 'p-2.5',
    3: 'p-3',
    4: 'p-4',
    5: 'p-5',
    6: 'p-6',
    8: 'p-8',
    10: 'p-10',
    12: 'p-12',
  },
  PAD_X: {
    0: 'px-0',
    0.5: 'px-0.5',
    1: 'px-1',
    1.5: 'px-1.5',
    2: 'px-2',
    2.5: 'px-2.5',
    3: 'px-3',
    4: 'px-4',
    5: 'px-5',
    6: 'px-6',
    8: 'px-8',
    10: 'px-10',
    12: 'px-12',
  },
  PAD_Y: {
    0: 'py-0',
    0.5: 'py-0.5',
    1: 'py-1',
    1.5: 'py-1.5',
    2: 'py-2',
    2.5: 'py-2.5',
    3: 'py-3',
    4: 'py-4',
    5: 'py-5',
    6: 'py-6',
    8: 'py-8',
    10: 'py-10',
    12: 'py-12',
  },
  PAD_TOP: {
    0: 'pt-0',
    0.5: 'pt-0.5',
    1: 'pt-1',
    1.5: 'pt-1.5',
    2: 'pt-2',
    2.5: 'pt-2.5',
    3: 'pt-3',
    4: 'pt-4',
    5: 'pt-5',
    6: 'pt-6',
    8: 'pt-8',
    10: 'pt-10',
    12: 'pt-12',
  },
  PAD_RIGHT: {
    0: 'pr-0',
    0.5: 'pr-0.5',
    1: 'pr-1',
    1.5: 'pr-1.5',
    2: 'pr-2',
    2.5: 'pr-2.5',
    3: 'pr-3',
    4: 'pr-4',
    5: 'pr-5',
    6: 'pr-6',
    8: 'pr-8',
    10: 'pr-10',
    12: 'pr-12',
  },
  PAD_BOTTOM: {
    0: 'pb-0',
    0.5: 'pb-0.5',
    1: 'pb-1',
    1.5: 'pb-1.5',
    2: 'pb-2',
    2.5: 'pb-2.5',
    3: 'pb-3',
    4: 'pb-4',
    5: 'pb-5',
    6: 'pb-6',
    8: 'pb-8',
    10: 'pb-10',
    12: 'pb-12',
  },
  PAD_LEFT: {
    0: 'pl-0',
    0.5: 'pl-0.5',
    1: 'pl-1',
    1.5: 'pl-1.5',
    2: 'pl-2',
    2.5: 'pl-2.5',
    3: 'pl-3',
    4: 'pl-4',
    5: 'pl-5',
    6: 'pl-6',
    8: 'pl-8',
    10: 'pl-10',
    12: 'pl-12',
  },
}

/**
 * Prefix per map, for the assembly check. The expected class name is derived
 * HERE, in the test, on purpose: this check catches a value filed under the
 * wrong key, which the literal table alone does not distinguish from a typo.
 */
const MAPS: ReadonlyArray<readonly [string, string, Record<PadStep, string>]> = [
  ['PAD', 'p', PAD],
  ['PAD_X', 'px', PAD_X],
  ['PAD_Y', 'py', PAD_Y],
  ['PAD_TOP', 'pt', PAD_TOP],
  ['PAD_RIGHT', 'pr', PAD_RIGHT],
  ['PAD_BOTTOM', 'pb', PAD_BOTTOM],
  ['PAD_LEFT', 'pl', PAD_LEFT],
]

/**
 * A padding utility and nothing else: one of the seven prefixes, a hyphen, a
 * step from the ladder. Anchored at both ends, so a stray space, a second
 * class, a variant chain or an arbitrary value all fail.
 */
const UTILITY_SHAPE = /^p[xytrbl]?-(?:0|0\.5|1|1\.5|2|2\.5|3|4|5|6|8|10|12)$/

/**
 * Characters that betray a name assembled at runtime or an arbitrary value.
 * Listed as single characters rather than one regex so the assertion message
 * names the offending character.
 */
const FORBIDDEN_CHARS = ['$', '{', '}', '[', ']', '(', ')', ' ']

describe('the step ladder', () => {
  it('is the settled ladder plus exactly one added step, 10', () => {
    expect(PAD_STEPS).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12])

    // Strict superset: nothing the vocabulary settled on was dropped.
    for (const step of SETTLED_STEPS) expect(PAD_STEPS).toContain(step)

    const added = PAD_STEPS.filter((s) => !SETTLED_STEPS.includes(s))
    expect(added).toEqual([10])
  })

  it('has 13 steps, sorted ascending, no duplicates', () => {
    expect(PAD_STEPS).toHaveLength(13)
    expect([...PAD_STEPS]).toEqual([...new Set(PAD_STEPS)].sort((a, b) => a - b))
    expect([...PAD_STEPS]).toEqual([...STEPS])
  })

  it('has 10 in the PadStep union, not only in the maps', () => {
    // TEN is typed PadStep, so this file fails tsc if the union lacks 10.
    expect(PAD[TEN]).toBe('p-10')
    expect(PAD_TOP[TEN]).toBe('pt-10')
  })
})

describe('the seven step maps are frozen', () => {
  it('the frozen table itself covers 7 maps at 13 steps each', () => {
    // Guards every loop below from going vacuous because this table lost a row.
    expect(Object.keys(FROZEN)).toHaveLength(7)
    for (const [name, table] of Object.entries(FROZEN)) {
      expect(name + ':' + Object.keys(table).length).toBe(name + ':13')
    }
  })

  it.each(MAPS)('%s has exactly the 13 ladder steps as keys', (name, _prefix, map) => {
    expect(name + ':' + Object.keys(map).length).toBe(name + ':13')
    expect(new Set(Object.keys(map).map(Number))).toEqual(new Set(STEPS.map(Number)))
  })

  it.each(MAPS)('%s matches the hand-written literal at every step', (name, _prefix, map) => {
    const expected = FROZEN[name]!
    for (const step of STEPS) {
      expect(name + '[' + step + '] = ' + map[step]).toBe(name + '[' + step + '] = ' + expected[step])
    }
  })

  it.each(MAPS)('%s names every step by the assembly rule too', (_name, prefix, map) => {
    for (const step of STEPS) {
      expect(map[step]).toBe(prefix + '-' + String(step))
    }
  })

  it.each(MAPS)('%s values are all distinct', (name, _prefix, map) => {
    const values = STEPS.map((step) => map[step])
    expect(name + ':' + new Set(values).size).toBe(name + ':13')
  })

  it.each(MAPS)('%s holds no placeholder, bracket value or compound class', (name, _prefix, map) => {
    for (const step of STEPS) {
      const value = map[step]
      for (const ch of FORBIDDEN_CHARS) {
        expect(name + '[' + step + '] contains ' + ch + ': ' + value.includes(ch)).toBe(
          name + '[' + step + '] contains ' + ch + ': false',
        )
      }
      expect(name + '[' + step + '] shape ok: ' + UTILITY_SHAPE.test(value)).toBe(
        name + '[' + step + '] shape ok: true',
      )
    }
  })

  it('files the seven prefixes under the seven map names, none swapped', () => {
    // Catches a copy-paste that puts the left column under PAD_RIGHT.
    const atStepTwo = MAPS.map(([, , map]) => map[2])
    expect(atStepTwo).toEqual(['p-2', 'px-2', 'py-2', 'pt-2', 'pr-2', 'pb-2', 'pl-2'])
    expect(new Set(atStepTwo).size).toBe(7)
  })

  it('spells the half-step per-side classes the amendment is named for', () => {
    // Named individually rather than derived, so a change to the assembly rule
    // above cannot silently take these with it.
    expect(PAD_TOP[2.5]).toBe('pt-2.5')
    expect(PAD_RIGHT[0.5]).toBe('pr-0.5')
    expect(PAD_BOTTOM[1.5]).toBe('pb-1.5')
    expect(PAD_LEFT[0.5]).toBe('pl-0.5')
  })

  it('spells the exact classes the two tracer pages need', () => {
    expect(PAD_TOP[2]).toBe('pt-2')
    expect(PAD_RIGHT[3]).toBe('pr-3')
    expect(PAD_BOTTOM[2]).toBe('pb-2')
    expect(PAD_LEFT[2]).toBe('pl-2')
    expect(PAD_X[4]).toBe('px-4')
    expect(PAD_Y[10]).toBe('py-10')
    expect(PAD[4]).toBe('p-4')
    expect(PAD[0.5]).toBe('p-0.5')
  })
})

describe('the classes are literal in the source, not interpolated', () => {
  it('has every one of the 91 class names present as a quoted literal', () => {
    const missing: string[] = []
    for (const [, , map] of MAPS) {
      for (const step of STEPS) {
        const cls = map[step]
        if (!SOURCE.includes("'" + cls + "'") && !SOURCE.includes('"' + cls + '"')) missing.push(cls)
      }
    }
    expect(missing).toEqual([])
  })

  it('contains no template literal in its CODE, so no class can be assembled at runtime', () => {
    // Deliberately blunt. Tailwind cannot see an interpolated class name, emits
    // nothing for it, and exits 0, so there is no louder signal available than
    // banning the syntax outright in this one file. If a template literal is
    // ever genuinely needed here, prove first that it cannot reach a class name.
    //
    // Comments are stripped first: the JSDoc uses backticks as prose markup for
    // prop and class names, the same way every other file in the design system
    // does, and that cannot generate anything. The stripper is naive about a
    // comment marker appearing inside a string, which is safe here because the
    // only strings in this file are class names.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code.includes(String.fromCharCode(96))).toBe(false)
  })
})

describe('padClasses branch 1 - nothing set, or a uniform step', () => {
  it('emits the empty string when no padding prop is passed', () => {
    // The anti-goal. A caller that says nothing about padding paints nothing,
    // so wrapping bare markup in a primitive can never introduce padding. A
    // primitive that wants a default supplies it at its own call boundary.
    expect(padClasses({})).toBe('')
    expect(padClasses({}).length).toBe(0)
  })

  it('emits the bare shorthand, which is what Card ships today', () => {
    expect(padClasses({ pad: 6 })).toBe('p-6')
    expect(padClasses({ pad: 6 }).split(' ')).toHaveLength(1)
  })

  it('emits the bare shorthand for every step', () => {
    for (const step of STEPS) expect(padClasses({ pad: step })).toBe(FROZEN.PAD![step])
  })

  it('treats step 0 as a real value, not as absent', () => {
    // A `||` fallback chain instead of `??` would silently drop all three.
    expect(padClasses({ pad: 0 })).toBe('p-0')
    expect(padClasses({ padX: 0, padY: 0 })).toBe('px-0 py-0')
    expect(padClasses({ pad: 4, padTop: 0 })).toBe('pt-0 pr-4 pb-4 pl-4')
  })
})

describe('padClasses branch 2 - an axis is set, no single side is', () => {
  it('names BOTH sides rather than the shorthand plus one axis', () => {
    // cn('p-6', 'px-3') keeps BOTH classes: tailwind-merge does not treat a
    // later horizontal-axis class as overriding an earlier shorthand one, so
    // which side wins would be decided by utility order inside the compiled
    // stylesheet rather than by this module.
    expect(padClasses({ pad: 6, padX: 3 })).toBe('px-3 py-6')
    expect(padClasses({ pad: 6, padX: 3 })).not.toContain('p-6')
  })

  it('reproduces the card.tsx shape for every step, both axes named', () => {
    for (const step of STEPS) {
      expect(padClasses({ pad: step, padX: 3 })).toBe('px-3 ' + FROZEN.PAD_Y![step])
      expect(padClasses({ pad: step, padY: 3 })).toBe(FROZEN.PAD_X![step] + ' py-3')
      expect(padClasses({ pad: step, padX: 3, padY: 2 })).toBe('px-3 py-2')
    }
  })

  it('names only the axis given when there is no uniform step to expand', () => {
    expect(padClasses({ padX: 4 })).toBe('px-4')
    expect(padClasses({ padY: 2.5 })).toBe('py-2.5')
    expect(padClasses({ padX: 4, padY: 2.5 })).toBe('px-4 py-2.5')
  })
})

describe('padClasses branch 3 - a single side is set', () => {
  it('the brief four-sided case: every side named, the side value winning on its own', () => {
    // pt-2 beats padY 3 and pad 6 on the top; the bottom, which no per-side
    // prop claims, takes padY 3; left and right take padX 4.
    expect(padClasses({ pad: 6, padY: 3, padTop: 2, padX: 4 })).toBe('pt-2 pr-4 pb-3 pl-4')

    const tokens = padClasses({ pad: 6, padY: 3, padTop: 2, padX: 4 }).split(' ')
    expect(tokens).toHaveLength(4)
    expect(tokens.map((t) => t.slice(0, 2))).toEqual(['pt', 'pr', 'pb', 'pl'])
  })

  it('expands a uniform step into all four sides', () => {
    expect(padClasses({ pad: 4, padTop: 2 })).toBe('pt-2 pr-4 pb-4 pl-4')
    expect(padClasses({ pad: 4, padBottom: 3 })).toBe('pt-4 pr-4 pb-3 pl-4')
  })

  it('handles the tab-rail shape that forced this amendment', () => {
    // InvoiceDetailPage:905 pads the rail on its top side alone. padY would
    // also pad the bottom, which is a rendered change and therefore forbidden.
    //
    // THE DIVERGENCE FROM THE BRIEF, asserted here: the bottom has no side, no
    // axis and no uniform value to resolve from, so it is not named at all. A
    // synthesised step-0 class is not a no-op, because padding is not
    // universally zeroed by the preflight reset. See this file's header.
    expect(padClasses({ padX: 4, padTop: 2 })).toBe('pt-2 pr-4 pl-4')
    expect(padClasses({ padX: 4, padTop: 2 })).not.toContain('pb-')
  })

  it('names only the side given when nothing else can be resolved', () => {
    expect(padClasses({ padTop: 2 })).toBe('pt-2')
    expect(padClasses({ padRight: 3 })).toBe('pr-3')
    expect(padClasses({ padBottom: 2 })).toBe('pb-2')
    expect(padClasses({ padLeft: 2 })).toBe('pl-2')
  })

  it('emits the four sides in top, right, bottom, left order', () => {
    expect(padClasses({ padTop: 1, padRight: 2, padBottom: 3, padLeft: 4 })).toBe(
      'pt-1 pr-2 pb-3 pl-4',
    )
  })

  it('applies the full precedence order: side beats axis beats uniform', () => {
    expect(
      padClasses({
        pad: 1,
        padX: 2,
        padY: 3,
        padTop: 4,
        padRight: 5,
        padBottom: 6,
        padLeft: 8,
      }),
    ).toBe('pt-4 pr-5 pb-6 pl-8')

    // Axis wins over uniform on the sides no per-side prop claims.
    expect(padClasses({ pad: 1, padX: 2, padY: 3, padTop: 4 })).toBe('pt-4 pr-2 pb-3 pl-2')

    // Uniform reaches a side with no axis of its own.
    expect(padClasses({ pad: 5, padTop: 1 })).toBe('pt-1 pr-5 pb-5 pl-5')
    expect(padClasses({ pad: 5, padY: 3, padLeft: 1 })).toBe('pt-3 pr-5 pb-3 pl-1')
  })

  it('honours a per-side step of 0', () => {
    expect(padClasses({ pad: 4, padBottom: 0 })).toBe('pt-4 pr-4 pb-0 pl-4')
  })
})

describe('padClasses invariants over every prop combination', () => {
  const KEYS = ['pad', 'padX', 'padY', 'padTop', 'padRight', 'padBottom', 'padLeft'] as const

  /** All 128 subsets of the seven props, each set to a distinct legal step. */
  function combinations(): Array<Record<string, PadStep>> {
    const steps: PadStep[] = [1, 2, 3, 4, 5, 6, 8]
    const out: Array<Record<string, PadStep>> = []
    for (let mask = 0; mask < 1 << KEYS.length; mask++) {
      const opts: Record<string, PadStep> = {}
      KEYS.forEach((k, i) => {
        if (mask & (1 << i)) opts[k] = steps[i]!
      })
      out.push(opts)
    }
    return out
  }

  it('never puts the shorthand and an override in the same string', () => {
    for (const opts of combinations()) {
      const out = padClasses(opts).split(' ').filter(Boolean)
      const hasShorthand = out.some((c) => /^p-/.test(c))
      const hasOverride = out.some((c) => /^p[xytrbl]-/.test(c))
      expect(hasShorthand && hasOverride, JSON.stringify(opts) + ' -> ' + out.join(' ')).toBe(false)
    }
  })

  it('emits only class names drawn from the seven maps, and never repeats one', () => {
    const legal = new Set(MAPS.flatMap(([, , map]) => STEPS.map((s) => map[s])))
    for (const opts of combinations()) {
      const out = padClasses(opts).split(' ').filter(Boolean)
      for (const cls of out) expect(legal.has(cls), cls + ' is not a published class').toBe(true)
      expect(new Set(out).size).toBe(out.length)
    }
  })

  it('emits no leading, trailing or doubled whitespace', () => {
    for (const opts of combinations()) {
      const out = padClasses(opts)
      expect(JSON.stringify(opts) + ' trimmed: ' + (out === out.trim())).toBe(
        JSON.stringify(opts) + ' trimmed: true',
      )
      expect(JSON.stringify(opts) + ' doubled: ' + out.includes('  ')).toBe(
        JSON.stringify(opts) + ' doubled: false',
      )
    }
  })

  it('is pure and stable: the same options always give the same string', () => {
    for (const opts of combinations()) expect(padClasses(opts)).toBe(padClasses(opts))
  })
})
