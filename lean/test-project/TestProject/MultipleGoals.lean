-- Fixture: Multiple simultaneous goals with goal splits and solves.

theorem multi_goals (p q r : Prop) (hp : p) (hq : q) (hr : r) : (p ∧ q) ∧ r := by
  constructor
  · constructor
    · exact hp
    · exact hq
  · exact hr
