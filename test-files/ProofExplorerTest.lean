import Mathlib

namespace ProofExplorerTest

/-- Small but non-trivial integration fixture for Proof Explorer. -/
def double (n : Nat) : Nat := 2 * n

def triple (n : Nat) : Nat := 3 * n

lemma double_zero : double 0 = 0 := by
  rfl

lemma double_one : double 1 = 2 := by
  rfl

lemma double_add (a b : Nat) :
    double (a + b) = double a + double b := by
  unfold double
  ring

lemma triple_add (a b : Nat) :
    triple (a + b) = triple a + triple b := by
  unfold triple
  ring

lemma double_double (n : Nat) :
    double (double n) = 4 * n := by
  unfold double
  ring

lemma triple_double (n : Nat) :
    triple (double n) = 6 * n := by
  unfold triple double
  ring

theorem arithmetic_chain (a b : Nat) :
    double (a + b) = 2 * a + 2 * b := by
  have h1 : double (a + b) = double a + double b := by
    exact double_add a b
  have h2 : double a = 2 * a := by
    rfl
  have h3 : double b = 2 * b := by
    rfl
  rw [h1, h2, h3]

theorem conjunction_example (a b : Nat)
    (ha : a = 5)
    (hb : b = 7) :
    a + b = 12 ∧ double a = 10 ∧ double b = 14 := by
  have hsum : a + b = 12 := by
    rw [ha, hb]
    norm_num
  have hdoubleA : double a = 10 := by
    rw [ha]
    rfl
  have hdoubleB : double b = 14 := by
    rw [hb]
    rfl
  constructor
  · exact hsum
  · constructor
    · exact hdoubleA
    · exact hdoubleB

lemma positive_double (n : Nat) (h : 0 < n) :
    0 < double n := by
  unfold double
  omega

lemma double_le_double (a b : Nat) (h : a ≤ b) :
    double a ≤ double b := by
  unfold double
  omega

lemma triple_le_triple (a b : Nat) (h : a ≤ b) :
    triple a ≤ triple b := by
  unfold triple
  omega

theorem monotonicity_chain (a b : Nat) (h : a ≤ b) :
    double a ≤ double b ∧ triple a ≤ triple b := by
  have h1 : double a ≤ double b := by
    exact double_le_double a b h
  have h2 : triple a ≤ triple b := by
    exact triple_le_triple a b h
  constructor
  · exact h1
  · exact h2

theorem reusable_lemmas (n : Nat) :
    double (double n) + triple (double n) = 10 * n := by
  have h1 : double (double n) = 4 * n := by
    exact double_double n
  have h2 : triple (double n) = 6 * n := by
    exact triple_double n
  rw [h1, h2]
  ring

theorem nested_reasoning (x y : Nat)
    (hx : x = 3)
    (hy : y = 4) :
    double (x + y) + triple x = 23 := by
  have hsum : x + y = 7 := by
    rw [hx, hy]
    norm_num
  have hdouble : double (x + y) = 14 := by
    rw [hsum]
    rfl
  have htriple : triple x = 9 := by
    rw [hx]
    rfl
  calc
    double (x + y) + triple x = 14 + 9 := by rw [hdouble, htriple]
    _ = 23 := by norm_num

end ProofExplorerTest
