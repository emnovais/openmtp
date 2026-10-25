package lifecycle

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

func confirmed() ReleaseResult {
	return ReleaseResult{Disposition: ReleaseConfirmed}
}

func begin(t *testing.T, owner *Owner) *Attempt {
	t.Helper()
	a, err := owner.Begin()
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func register(t *testing.T, a *Attempt, id string, category Category, release ReleaseFunc) {
	t.Helper()
	if err := a.Register(id, category, release); err != nil {
		t.Fatal(err)
	}
}

func ready(t *testing.T, a *Attempt) Evidence {
	t.Helper()
	if _, err := a.Validate(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	e, err := a.Commit()
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func requireEvidence(t *testing.T, e Evidence, state State, outcome Outcome, registered, remaining int, acknowledged bool) {
	t.Helper()
	if e.Version != 1 || e.State != state || e.Outcome != outcome || e.Registered != registered || e.Remaining != remaining || e.CleanupAcknowledged != acknowledged {
		t.Fatalf("unexpected evidence: %+v", e)
	}
	total := 0
	for _, count := range e.RemainingByCategory {
		total += count
	}
	if total != remaining || len(e.Resources) != registered {
		t.Fatalf("inconsistent counts: %+v", e)
	}
}

func TestSuccessfulInitialization(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	e := ready(t, a)
	requireEvidence(t, e, Ready, OutcomeReady, 1, 1, false)
	if e.AttemptID != 1 || e.CleanupAttempted || e.Resources[0].Status != NotAttempted {
		t.Fatalf("session should remain owned: %+v", e)
	}
	if _, err := owner.Begin(); !errors.Is(err, ErrOwned) {
		t.Fatalf("committed owner admitted initialization: %v", err)
	}
}

func TestFailureBeforeAcquisition(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	primary := errors.New("initialization failed before acquisition")
	e, err := a.Fail(primary)
	if !errors.Is(err, primary) || !errors.Is(e.PrimaryError, primary) {
		t.Fatal("lost primary error")
	}
	requireEvidence(t, e, Closed, OutcomeFailedNoResources, 0, 0, false)
	if e.CleanupAttempted || len(e.CleanupErrors) != 0 {
		t.Fatalf("invented cleanup: %+v", e)
	}
}

func TestFailureAfterOneAcquisition(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	calls := 0
	register(t, a, "context", Context, func() ReleaseResult {
		calls++
		return confirmed()
	})
	e, _ := a.Fail(errors.New("next acquisition failed"))
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
	if calls != 1 || !e.CleanupAttempted || e.Resources[0].Status != Released {
		t.Fatalf("release not recorded: calls=%d evidence=%+v", calls, e)
	}
}

func TestFailureAfterMultipleAcquisitionsAndRollbackOrder(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	var order []string
	// Deliberately shuffled: cleanup must use categories, not just a reversed list.
	resources := []struct {
		id       string
		category Category
	}{
		{"context", Context}, {"handle", USBHandle}, {"worker-1", BackgroundWorker},
		{"enumeration", Enumeration}, {"session", MTPSession},
		{"device", DeviceReference}, {"interface", ClaimedInterface},
		{"worker-2", BackgroundWorker},
	}
	for _, item := range resources {
		id := item.id // Go 1.16 range-variable capture.
		register(t, a, id, item.category, func() ReleaseResult {
			order = append(order, id)
			return confirmed()
		})
	}
	e, _ := a.Fail(errors.New("metadata validation failed"))
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 8, 0, true)
	want := []string{"worker-2", "worker-1", "session", "interface", "handle", "device", "enumeration", "context"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("release order %v; want %v", order, want)
	}
}

func TestCleanupFailurePreservesDependenciesAndErrors(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	primary := errors.New("initialization failure")
	cleanupErr := errors.New("handle release rejected")
	contextCalls := 0
	register(t, a, "context", Context, func() ReleaseResult {
		contextCalls++
		return confirmed()
	})
	register(t, a, "handle", USBHandle, func() ReleaseResult {
		return ReleaseResult{Disposition: ReleaseRejected, Err: cleanupErr}
	})
	register(t, a, "session", MTPSession, confirmed)
	e, err := a.Fail(primary)
	requireEvidence(t, e, Uncertain, OutcomeFailedIncomplete, 3, 2, false)
	if contextCalls != 0 || !errors.Is(err, primary) || !errors.Is(e.PrimaryError, primary) {
		t.Fatal("released a dependency or lost the primary error")
	}
	if len(e.CleanupErrors) != 1 || e.CleanupErrors[0].ResourceID != "handle" || e.CleanupErrors[0].Category != USBHandle || !errors.Is(e.CleanupErrors[0].Err, cleanupErr) {
		t.Fatalf("lost cleanup error: %+v", e.CleanupErrors)
	}
	if e.Resources[0].Status != NotAttempted || e.Resources[1].Status != Failed || e.Resources[2].Status != Released {
		t.Fatalf("incorrect release records: %+v", e.Resources)
	}
}

func TestCleanupPanicIsUnknown(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "handle", USBHandle, func() ReleaseResult { panic("release panic") })
	e, _ := a.Fail(errors.New("primary"))
	requireEvidence(t, e, Uncertain, OutcomeFailedUnknown, 1, 1, false)
	var panicErr *CallbackPanicError
	if len(e.CleanupErrors) != 1 || !errors.As(e.CleanupErrors[0].Err, &panicErr) || panicErr.Stage != "release" || panicErr.Value != "release panic" {
		t.Fatalf("panic not retained: %+v", e.CleanupErrors)
	}
}

func TestNilPanicIsNotSuccessfulCleanup(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "handle", USBHandle, func() ReleaseResult { panic(nil) })
	e, _ := a.Fail(errors.New("primary"))
	requireEvidence(t, e, Uncertain, OutcomeFailedUnknown, 1, 1, false)
	var panicErr *CallbackPanicError
	if len(e.CleanupErrors) != 1 || !errors.As(e.CleanupErrors[0].Err, &panicErr) {
		t.Fatal("panic(nil) was not retained")
	}
}

func TestUnknownCleanupCompletion(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "worker", BackgroundWorker, func() ReleaseResult { return ReleaseResult{} })
	e, _ := a.Fail(errors.New("primary"))
	requireEvidence(t, e, Uncertain, OutcomeFailedUnknown, 1, 1, false)
	if !errors.Is(e.CleanupErrors[0].Err, ErrUnverifiedRelease) {
		t.Fatal("nil callback error incorrectly acknowledged cleanup")
	}
}

func TestRepeatedCleanupCannotClearUncertainty(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	calls := 0
	register(t, a, "handle", USBHandle, func() ReleaseResult {
		calls++
		return ReleaseResult{Disposition: ReleaseRejected}
	})
	first, _ := a.Fail(errors.New("primary"))
	for i := 0; i < 3; i++ {
		e, err := owner.Close()
		if !errors.Is(err, ErrUncertain) || !reflect.DeepEqual(e, first) {
			t.Fatalf("repeated cleanup changed uncertainty: %+v, %v", e, err)
		}
	}
	if _, err := a.Fail(errors.New("replacement primary")); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("repeated rollback admitted: %v", err)
	}
	if calls != 1 {
		t.Fatalf("release called %d times", calls)
	}
}

func TestConcurrentInitializationHasOneWinner(t *testing.T) {
	var owner Owner
	const contenders = 16
	start := make(chan struct{})
	results := make(chan error, contenders)
	var workers sync.WaitGroup
	for i := 0; i < contenders; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := owner.Begin()
			results <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else if !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
	}
	if winners != 1 || owner.Snapshot().AttemptID != 1 {
		t.Fatalf("initialization winners: %d", winners)
	}
}

func TestInitializationAndConcurrentCleanupBlockedDuringRelease(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	entered := make(chan struct{})
	finish := make(chan struct{})
	done := make(chan Evidence, 1)
	register(t, a, "session", MTPSession, func() ReleaseResult {
		close(entered) // A second invocation would panic and fail this test.
		<-finish
		return confirmed()
	})
	ready(t, a)
	go func() {
		e, _ := owner.Close()
		done <- e
	}()
	<-entered
	// No timeout clears ownership while the release callback remains unresolved.
	e := owner.Snapshot()
	requireEvidence(t, e, Releasing, "", 1, 1, false)
	if e.Resources[0].Status != InProgress || !e.CleanupAttempted {
		t.Error("in-flight release missing from evidence")
	}
	if _, err := owner.Begin(); !errors.Is(err, ErrBusy) {
		t.Errorf("initialization admitted during cleanup: %v", err)
	}
	if _, err := owner.Close(); !errors.Is(err, ErrBusy) {
		t.Errorf("concurrent cleanup admitted: %v", err)
	}
	if err := a.Register("late", Context, confirmed); !errors.Is(err, ErrBusy) {
		t.Errorf("registration admitted during release: %v", err)
	}
	close(finish)
	requireEvidence(t, <-done, Closed, OutcomeClosed, 1, 0, true)
}

func TestCleanupDuringInitializationIsRejected(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	calls := 0
	register(t, a, "context", Context, func() ReleaseResult {
		calls++
		return confirmed()
	})
	if _, err := owner.Close(); !errors.Is(err, ErrBusy) || calls != 0 {
		t.Fatal("cleanup overlapped acquisition")
	}
	e, _ := a.Fail(errors.New("caller aborts acquisition"))
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
}

func TestFreshInitializationAfterConfirmedCleanup(t *testing.T) {
	var owner Owner
	first := begin(t, &owner)
	register(t, first, "context", Context, confirmed)
	e, _ := first.Fail(errors.New("first failed"))
	second := begin(t, &owner)
	register(t, second, "context", Context, confirmed)
	register(t, second, "session", MTPSession, confirmed)
	next := ready(t, second)
	if next.AttemptID != e.AttemptID+1 || next.PrimaryError != nil || len(next.CleanupErrors) != 0 {
		t.Fatalf("old evidence leaked into new attempt: %+v", next)
	}
}

func TestInitializationRejectedAfterUncertainCleanup(t *testing.T) {
	for _, disposition := range []ReleaseDisposition{ReleaseUnknown, ReleaseRejected} {
		var owner Owner
		a := begin(t, &owner)
		register(t, a, "handle", USBHandle, func() ReleaseResult {
			return ReleaseResult{Disposition: disposition}
		})
		a.Fail(errors.New("primary"))
		before := owner.Snapshot()
		if _, err := owner.Begin(); !errors.Is(err, ErrUncertain) {
			t.Fatalf("uncertain owner admitted new attempt: %v", err)
		}
		if !reflect.DeepEqual(before, owner.Snapshot()) {
			t.Fatal("failed initialization request changed uncertain evidence")
		}
	}
}

func TestCommitBeforeValidation(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	e, err := a.Commit()
	if !errors.Is(err, ErrNotValidated) {
		t.Fatalf("unvalidated commit accepted: %v", err)
	}
	requireEvidence(t, e, Acquiring, "", 1, 1, false)
}

func TestDoubleRegistrationDoesNotTakeSecondResource(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	firstCalls, secondCalls := 0, 0
	register(t, a, "handle", USBHandle, func() ReleaseResult {
		firstCalls++
		return confirmed()
	})
	err := a.Register("handle", USBHandle, func() ReleaseResult {
		secondCalls++
		return confirmed()
	})
	if !errors.Is(err, ErrDuplicateResource) {
		t.Fatalf("duplicate registration accepted: %v", err)
	}
	e, _ := a.Fail(errors.New("duplicate rejected"))
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
	if firstCalls != 1 || secondCalls != 0 {
		t.Fatal("duplicate callback replaced registered ownership")
	}
	// The caller still owns the rejected resource and must handle it separately.
}

func TestNoDuplicateReleaseAfterSuccessfulRollback(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	calls := 0
	register(t, a, "handle", USBHandle, func() ReleaseResult {
		calls++
		return confirmed()
	})
	e, _ := a.Fail(errors.New("primary"))
	for i := 0; i < 3; i++ {
		again, err := owner.Close()
		if err != nil || !reflect.DeepEqual(e, again) {
			t.Fatal("closed evidence changed")
		}
	}
	if calls != 1 {
		t.Fatalf("release called %d times", calls)
	}
}

func TestAccurateCountsAcrossCategoriesAndPartialRollback(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "context", Context, confirmed)
	register(t, a, "handle-1", USBHandle, confirmed)
	register(t, a, "handle-2", USBHandle, func() ReleaseResult {
		return ReleaseResult{Disposition: ReleaseRejected}
	})
	register(t, a, "session", MTPSession, confirmed)
	e := owner.Snapshot()
	requireEvidence(t, e, Acquiring, "", 4, 4, false)
	if e.RemainingByCategory[USBHandle] != 2 || e.RemainingByCategory[Context] != 1 || e.RemainingByCategory[MTPSession] != 1 {
		t.Fatalf("incorrect initial category counts: %v", e.RemainingByCategory)
	}
	e, _ = a.Fail(errors.New("primary"))
	requireEvidence(t, e, Uncertain, OutcomeFailedIncomplete, 4, 3, false)
	if e.RemainingByCategory[USBHandle] != 2 || e.RemainingByCategory[Context] != 1 || e.RemainingByCategory[MTPSession] != 0 {
		t.Fatalf("incorrect retained counts: %v", e.RemainingByCategory)
	}
}

func TestSessionClosureAfterSuccessfulCommit(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	calls := 0
	register(t, a, "session", MTPSession, func() ReleaseResult {
		calls++
		return confirmed()
	})
	ready(t, a)
	e, err := owner.Close()
	if err != nil {
		t.Fatal(err)
	}
	requireEvidence(t, e, Closed, OutcomeClosed, 1, 0, true)
	if e.PrimaryError != nil || !e.CleanupAttempted {
		t.Fatal("normal closure confused with failed initialization")
	}
	owner.Close()
	if calls != 1 {
		t.Fatal("session released twice")
	}
	begin(t, &owner)
}

func TestValidationFailureAutomaticallyRollsBack(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	primary := errors.New("session metadata invalid")
	e, err := a.Validate(func() error { return primary })
	if !errors.Is(err, primary) || !errors.Is(e.PrimaryError, primary) {
		t.Fatal("lost validation failure")
	}
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
	if _, err := a.Commit(); !errors.Is(err, ErrInvalidState) {
		t.Fatal("failed prospective session committed")
	}
}

func TestValidationPanicRollsBack(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	e, err := a.Validate(func() error { panic("validation panic") })
	var panicErr *CallbackPanicError
	if !errors.As(err, &panicErr) || panicErr.Stage != "validation" {
		t.Fatalf("validation panic lost: %v", err)
	}
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
}

func TestValidationReservationAndReentrantCalls(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	entered := make(chan struct{})
	finish := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := a.Validate(func() error {
			// Reentrant bookkeeping must not deadlock behind an external callback.
			if owner.Snapshot().State != Acquiring {
				return errors.New("incorrect validation state")
			}
			if _, err := owner.Close(); !errors.Is(err, ErrBusy) {
				return errors.New("reentrant close admitted")
			}
			close(entered)
			<-finish
			return nil
		})
		done <- err
	}()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("validator returned before reservation checks: %v", err)
	}
	if _, err := owner.Begin(); !errors.Is(err, ErrBusy) {
		t.Error("initialization overlapped validation")
	}
	if _, err := a.Commit(); !errors.Is(err, ErrBusy) {
		t.Error("commit overlapped validation")
	}
	if _, err := a.Fail(errors.New("interruption")); !errors.Is(err, ErrBusy) {
		t.Error("rollback overlapped validation")
	}
	if err := a.Register("late", Context, confirmed); !errors.Is(err, ErrBusy) {
		t.Error("registration overlapped validation")
	}
	if _, err := a.Validate(func() error { return nil }); !errors.Is(err, ErrBusy) {
		t.Error("concurrent validation admitted")
	}
	close(finish)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := a.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseCallbackCanReenterWithoutDeadlock(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, func() ReleaseResult {
		if owner.Snapshot().State != Releasing {
			return ReleaseResult{Err: errors.New("incorrect cleanup state")}
		}
		if _, err := owner.Close(); !errors.Is(err, ErrBusy) {
			return ReleaseResult{Err: errors.New("reentrant cleanup admitted")}
		}
		if _, err := owner.Begin(); !errors.Is(err, ErrBusy) {
			return ReleaseResult{Err: errors.New("reentrant initialization admitted")}
		}
		if _, err := a.Fail(errors.New("replacement")); !errors.Is(err, ErrBusy) {
			return ReleaseResult{Err: errors.New("reentrant rollback admitted")}
		}
		return confirmed()
	})
	e, _ := a.Fail(errors.New("primary"))
	requireEvidence(t, e, Closed, OutcomeFailedCleaned, 1, 0, true)
}

func TestNewRegistrationInvalidatesValidation(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "context", Context, confirmed)
	if _, err := a.Validate(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	register(t, a, "session", MTPSession, confirmed)
	if _, err := a.Commit(); !errors.Is(err, ErrNotValidated) {
		t.Fatal("commit used validation from an earlier resource set")
	}
	ready(t, a)
}

func TestStaleAttemptCannotAffectNewOwnerGeneration(t *testing.T) {
	var owner Owner
	old := begin(t, &owner)
	old.Fail(errors.New("old failure"))
	current := begin(t, &owner)
	register(t, current, "current", Context, confirmed)
	before := owner.Snapshot()
	if err := old.Register("stale", USBHandle, confirmed); !errors.Is(err, ErrStaleAttempt) {
		t.Fatal("stale registration accepted")
	}
	if _, err := old.Validate(func() error {
		t.Error("stale validator ran")
		return nil
	}); !errors.Is(err, ErrStaleAttempt) {
		t.Fatal("stale validation accepted")
	}
	if _, err := old.Commit(); !errors.Is(err, ErrStaleAttempt) {
		t.Fatal("stale commit accepted")
	}
	if _, err := old.Fail(errors.New("stale failure")); !errors.Is(err, ErrStaleAttempt) {
		t.Fatal("stale rollback accepted")
	}
	if !reflect.DeepEqual(before, owner.Snapshot()) {
		t.Fatal("stale handle changed current state")
	}
}

func TestSnapshotsCannotForgeAcknowledgementOrCounts(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "handle", USBHandle, func() ReleaseResult { return ReleaseResult{} })
	a.Fail(errors.New("primary"))
	before := owner.Snapshot()
	forged := owner.Snapshot()
	forged.CleanupAcknowledged = true
	forged.State = Closed
	forged.RemainingByCategory[USBHandle] = 0
	forged.Resources[0].Status = Released
	forged.CleanupErrors[0].Err = nil
	if !reflect.DeepEqual(before, owner.Snapshot()) {
		t.Fatal("external snapshot mutation changed ownership evidence")
	}
	if _, err := owner.Begin(); !errors.Is(err, ErrUncertain) {
		t.Fatal("forged snapshot admitted initialization")
	}
}

func TestInvalidReleaseResultsRemainUncertain(t *testing.T) {
	cleanupErr := errors.New("release failed")
	cases := []struct {
		name   string
		result ReleaseResult
		want   error
	}{
		{"acknowledgement-with-error", ReleaseResult{Disposition: ReleaseConfirmed, Err: cleanupErr}, cleanupErr},
		{"unknown-with-error", ReleaseResult{Err: cleanupErr}, cleanupErr},
		{"invalid-disposition", ReleaseResult{Disposition: ReleaseDisposition(255)}, ErrInvalidRelease},
		{"invalid-disposition-with-error", ReleaseResult{Disposition: ReleaseDisposition(255), Err: cleanupErr}, cleanupErr},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			var owner Owner
			a := begin(t, &owner)
			register(t, a, "handle", USBHandle, func() ReleaseResult { return item.result })
			e, _ := a.Fail(errors.New("primary"))
			requireEvidence(t, e, Uncertain, OutcomeFailedUnknown, 1, 1, false)
			if !errors.Is(e.CleanupErrors[0].Err, item.want) {
				t.Fatalf("cleanup error lost: %v", e.CleanupErrors[0].Err)
			}
		})
	}
}

func TestInvalidRegistrationLeavesResponsibilityWithCaller(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	for _, err := range []error{
		a.Register("", Context, confirmed),
		a.Register("unknown", Category("invalid"), confirmed),
		a.Register("no-release", USBHandle, nil),
	} {
		if !errors.Is(err, ErrInvalidResource) {
			t.Fatalf("invalid resource accepted: %v", err)
		}
	}
	requireEvidence(t, owner.Snapshot(), Acquiring, "", 0, 0, false)
}

func TestNilValidationAndMissingPrimaryDoNotPublishOrRelease(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	if _, err := a.Validate(nil); !errors.Is(err, ErrInvalidValidator) {
		t.Fatal("nil validation accepted")
	}
	if _, err := a.Fail(nil); !errors.Is(err, ErrMissingFailure) {
		t.Fatal("missing primary accepted")
	}
	if _, err := a.Commit(); !errors.Is(err, ErrNotValidated) {
		t.Fatal("programming error silently validated session")
	}
	requireEvidence(t, owner.Snapshot(), Acquiring, "", 1, 1, false)
}

func TestCloseCommittedSessionWithUnverifiedRelease(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, func() ReleaseResult { return ReleaseResult{} })
	ready(t, a)
	e, err := owner.Close()
	if !errors.Is(err, ErrUncertain) || e.PrimaryError != nil {
		t.Fatal("session close error confused with initialization failure")
	}
	requireEvidence(t, e, Uncertain, OutcomeFailedUnknown, 1, 1, false)
}

func TestZeroOwnerAndEmptyClose(t *testing.T) {
	var owner Owner
	requireEvidence(t, owner.Snapshot(), Empty, "", 0, 0, false)
	e, err := owner.Close()
	if err != nil {
		t.Fatal(err)
	}
	requireEvidence(t, e, Closed, OutcomeClosed, 0, 0, false)
	if e.CleanupAttempted {
		t.Fatal("empty close invented cleanup acknowledgement")
	}
	begin(t, &owner)
}

func TestIndependentOwnersAndMonotonicAttemptIDs(t *testing.T) {
	var first, second Owner
	a := begin(t, &first)
	b := begin(t, &second)
	register(t, a, "session", MTPSession, confirmed)
	register(t, b, "session", MTPSession, confirmed)
	ready(t, a)
	ready(t, b)
	first.Close()
	requireEvidence(t, second.Snapshot(), Ready, OutcomeReady, 1, 1, false)
	if next := begin(t, &first); next.id != 2 {
		t.Fatal("attempt ID not monotonic")
	}
}

func TestAttemptIDCannotWrap(t *testing.T) {
	owner := Owner{attemptID: ^uint64(0)}
	if _, err := owner.Begin(); !errors.Is(err, ErrAttemptIDsExhausted) {
		t.Fatal("attempt ID wrapped")
	}
	requireEvidence(t, owner.Snapshot(), Empty, "", 0, 0, false)
}

func TestNilAttemptMethodsAreRejected(t *testing.T) {
	for _, a := range []*Attempt{nil, new(Attempt)} {
		if err := a.Register("context", Context, confirmed); !errors.Is(err, ErrStaleAttempt) {
			t.Fatal("invalid attempt registered resource")
		}
		if _, err := a.Validate(func() error { return nil }); !errors.Is(err, ErrStaleAttempt) {
			t.Fatal("invalid attempt validated")
		}
		if _, err := a.Commit(); !errors.Is(err, ErrStaleAttempt) {
			t.Fatal("invalid attempt committed")
		}
		if _, err := a.Fail(errors.New("primary")); !errors.Is(err, ErrStaleAttempt) {
			t.Fatal("invalid attempt rolled back")
		}
	}
}

func TestCommitRequiresRegisteredSession(t *testing.T) {
	for _, withContext := range []bool{false, true} {
		var owner Owner
		a := begin(t, &owner)
		if withContext {
			register(t, a, "context", Context, confirmed)
		}
		if _, err := a.Validate(func() error { return nil }); err != nil {
			t.Fatal(err)
		}
		if _, err := a.Commit(); !errors.Is(err, ErrMissingSession) {
			t.Fatalf("resource-free or session-free owner committed: %v", err)
		}
		if owner.Snapshot().State != Acquiring {
			t.Fatal("rejected commit changed ownership state")
		}
	}
}

func TestCommittedSessionRejectsInitializationChanges(t *testing.T) {
	var owner Owner
	a := begin(t, &owner)
	register(t, a, "session", MTPSession, confirmed)
	before := ready(t, a)
	if err := a.Register("late", Context, confirmed); !errors.Is(err, ErrInvalidState) {
		t.Fatal("committed session admitted an acquisition")
	}
	if _, err := a.Validate(func() error {
		t.Error("validator ran after commit")
		return nil
	}); !errors.Is(err, ErrInvalidState) {
		t.Fatal("committed session admitted validation")
	}
	if _, err := a.Commit(); !errors.Is(err, ErrInvalidState) {
		t.Fatal("committed session committed twice")
	}
	if _, err := a.Fail(errors.New("late failure")); !errors.Is(err, ErrInvalidState) {
		t.Fatal("committed session admitted initialization rollback")
	}
	if !reflect.DeepEqual(before, owner.Snapshot()) {
		t.Fatal("rejected initialization change modified committed ownership")
	}
}
