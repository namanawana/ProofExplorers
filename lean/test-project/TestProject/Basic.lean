-- Fixture 1+2+5: simple theorem, multiple goals, dependent lemmas.
-- Needs no Mathlib, so it elaborates on a bare Lean toolchain.

theorem and_swap (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
  constructor
  · exact hp
  · exact hq

theorem helper_add_zero (n : Nat) : n + 0 = n := by
  simp

-- Fixture 3: nested `have` (sub-proof) next to a term-mode `have`.
theorem nested (n : Nat) : n + 0 = n := by
  have h : n + 0 = n := by
    exact helper_add_zero n
  have k : n = n := rfl
  exact h
