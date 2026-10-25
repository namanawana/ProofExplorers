-- Fixture: Case blocks with distinct inner tactics.

theorem case_blocks (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  case left =>
    exact hp
  case right =>
    exact hq
