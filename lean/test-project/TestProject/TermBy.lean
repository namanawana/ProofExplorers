-- Fixture: Nested `by` inside terms and subproofs.

theorem term_by_example (n : Nat) : n + 0 = n := by
  have h1 : n + 0 = n := by
    exact Nat.add_zero n
  have h2 : n = n := (by rfl)
  exact h1
