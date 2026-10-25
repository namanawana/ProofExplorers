-- Fixture: Wrapped declarations spanning multiple lines with column-0 continuations.

theorem wrapped_statement
    (p q : Prop)
    (hp : p)
    (hq : q)
    : p ∧ q
    := by
  constructor
  · exact hp
  · exact hq
