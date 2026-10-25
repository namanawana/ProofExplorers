-- Fixture: Large navigable Lean file with multiple namespaces and theorems.

namespace Geometry

def point (x y : Nat) : Nat × Nat := (x, y)

theorem point_eq (x y : Nat) : point x y = (x, y) := by
  rfl

namespace Transform

theorem shift_x (x y : Nat) : point (x + 0) y = point x y := by
  have hx : x + 0 = x := by
    exact Nat.add_zero x
  rw [hx]

theorem shift_y (x y : Nat) : point x (y + 0) = point x y := by
  have hy : y + 0 = y := by
    exact Nat.add_zero y
  rw [hy]

end Transform

end Geometry

namespace Algebra

theorem add_comm_zero (n : Nat) : 0 + n = n := by
  simp

theorem add_assoc_zero (n : Nat) : (n + 0) + 0 = n := by
  have h1 : n + 0 = n := Nat.add_zero n
  rw [h1]
  exact Nat.add_zero n

end Algebra
