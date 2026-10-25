-- Fixture 8: failed tactic. Lean must report an error on the `exact` line;
-- the engine must reject that step and leave the committed state untouched
-- (Invariant 3). Used by the real-Lean integration test (docs/TASKS.md P1-03).

theorem will_fail (p q : Prop) (hp : p) : p ∧ q := by
  constructor
  · exact hp
  · exact hp
