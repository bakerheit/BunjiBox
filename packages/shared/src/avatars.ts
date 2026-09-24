// Additive catalog: legacy IDs and their renderer geometry stay unchanged.
// Coordinates use a 100-point square, mirrored by DistinctAvatarShapes.swift.
export interface DistinctAvatarShape {
  name: string
  label: string
  glyph: string
  path: string
  cx: number
  cy: number
}

export const distinctAvatarShapes: readonly DistinctAvatarShape[] = [
  {
    "name": "comet",
    "label": "Comet",
    "glyph": "☄",
    "path": "M 8 10 L 61 22 C 85 26 97 47 89 69 C 81 93 51 98 34 80 L 10 52 L 32 54 L 8 10 Z",
    "cx": 61,
    "cy": 59
  },
  {
    "name": "sprout",
    "label": "Sprout",
    "glyph": "♧",
    "path": "M 44 91 L 44 57 C 15 59 7 37 10 16 C 33 15 48 25 50 43 C 54 21 72 10 92 12 C 93 37 80 55 56 57 L 56 91 Z",
    "cx": 69,
    "cy": 33
  },
  {
    "name": "ribbon",
    "label": "Folded ribbon",
    "glyph": "⋈",
    "path": "M 12 12 L 67 12 L 89 34 L 65 58 L 88 88 L 33 88 L 11 66 L 35 42 Z",
    "cx": 50,
    "cy": 50
  },
  {
    "name": "orbit",
    "label": "Orbit",
    "glyph": "⊙",
    "path": "M 23 38 C 24 4 71 3 79 34 C 99 25 99 41 82 58 C 77 93 31 96 22 66 C 0 77 1 59 23 38 Z",
    "cx": 51,
    "cy": 49
  },
  {
    "name": "lantern",
    "label": "Lantern",
    "glyph": "♜",
    "path": "M 35 8 L 65 8 L 65 20 L 82 32 L 75 77 L 59 86 L 59 94 L 41 94 L 41 86 L 25 77 L 18 32 L 35 20 Z",
    "cx": 50,
    "cy": 52
  },
  {
    "name": "notched-tile",
    "label": "Notched tile",
    "glyph": "▣",
    "path": "M 16 10 L 84 10 Q 90 10 90 16 L 90 38 L 76 38 L 76 62 L 90 62 L 90 84 Q 90 90 84 90 L 16 90 Q 10 90 10 84 L 10 62 L 24 62 L 24 38 L 10 38 L 10 16 Q 10 10 16 10 Z",
    "cx": 50,
    "cy": 50
  }
]

