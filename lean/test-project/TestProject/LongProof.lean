-- Fixture: Long multi-step proof with multiple tactics and checkpoint crossings.

theorem long_proof (a b c d : Nat) (h1 : a = b) (h2 : b = c) (h3 : c = d) : a = d := by
  have s1 : a = c := by
    rw [h1]
    exact h2
  have s2 : b = d := by
    rw [h2]
    exact h3
  rw [s1]
  exact h3
