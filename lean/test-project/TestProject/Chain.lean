-- Fixtures 4+5: multiple dependent lemmas forming a small DAG.
--   thmC -> lemB -> lemA      and      thmC -> lemA

lemma lemA (n : Nat) : n + 0 = n := by
  simp

lemma lemB (n : Nat) : n + 0 + 0 = n := by
  have h : n + 0 = n := lemA n
  simp [h]

theorem thmC (n : Nat) : n + 0 + 0 = n + 0 := by
  have h1 : n + 0 + 0 = n := lemB n
  have h2 : n + 0 = n := lemA n
  simp [h1, h2]
