-- Fixture: Base module of an import pair.

def base_const (n : Nat) : Nat := n + 1

theorem base_thm (n : Nat) : base_const n = n + 1 := by
  rfl
