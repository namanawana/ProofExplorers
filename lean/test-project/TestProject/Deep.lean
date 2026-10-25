-- Fixture 10: deeply nested proof (4 levels of `have ... := by`).
-- No depth limit exists anywhere in the model (Invariant 7).

theorem deep (n : Nat) : n = n := by
  have a : n = n := by
    have b : n = n := by
      have c : n = n := by
        have d : n = n := by
          rfl
        exact d
      exact c
    exact b
  exact a
