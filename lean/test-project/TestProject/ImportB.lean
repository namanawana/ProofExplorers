-- Fixture: Dependent module importing ImportA and referencing base_thm.
import TestProject.ImportA

theorem derived_thm (n : Nat) : base_const n = n + 1 := by
  exact base_thm n
