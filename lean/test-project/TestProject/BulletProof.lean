-- Fixture: Bullet branches with multiple inner tactics per branch.

theorem bullet_proof (p q : Prop) (hp : p) (hq : q) : (p ∧ p) ∧ (q ∧ q) := by
  constructor
  · constructor
    · exact hp
    · exact hp
  · constructor
    · exact hq
    · exact hq
