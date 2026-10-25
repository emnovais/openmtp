// Package lifecycle is an isolated, pure-Go ownership prototype. It neither
// opens devices nor participates in the production Kalam lifecycle.
//
// A successful Register transfers responsibility for one already-acquired
// resource to the owner. The caller must register immediately after acquisition
// and retains responsibility if registration is rejected. Release callbacks
// must acknowledge actual release, not merely submission of asynchronous work.
// The acquisition adapter must also register resources returned alongside an
// acquisition error before calling Fail; unregistered resources are not tracked.
//
// All bookkeeping is protected by Owner.mu. External validation and release
// callbacks run without that lock. A state reservation prevents other lifecycle
// work during callbacks; competing calls fail rather than wait. No timeout can
// release that reservation. A callback that never returns leaves the owner busy.
package lifecycle

import (
	"errors"
	"fmt"
	"sync"
)

type State string

const (
	Empty     State = "empty"
	Acquiring State = "acquiring"
	Ready     State = "ready"
	Releasing State = "releasing"
	Closed    State = "closed"
	Uncertain State = "uncertain"
)

type Category string

const (
	Context          Category = "context"
	Enumeration      Category = "enumeration"
	DeviceReference  Category = "device-reference"
	USBHandle        Category = "usb-handle"
	ClaimedInterface Category = "claimed-interface"
	MTPSession       Category = "mtp-session"
	BackgroundWorker Category = "background-worker"
)

type ReleaseDisposition uint8

const (
	// The zero value deliberately cannot acknowledge release.
	ReleaseUnknown ReleaseDisposition = iota
	// ReleaseConfirmed means the entire release finished, with a nil error.
	ReleaseConfirmed
	// ReleaseRejected positively reports that the resource remains owned.
	// Errors with uncertain or partial release must use ReleaseUnknown instead.
	ReleaseRejected
)

type ReleaseResult struct {
	Disposition ReleaseDisposition
	Err         error
}

type ReleaseFunc func() ReleaseResult

type ReleaseStatus string

const (
	NotAttempted ReleaseStatus = "not-attempted"
	InProgress   ReleaseStatus = "in-progress"
	Released     ReleaseStatus = "released"
	Failed       ReleaseStatus = "failed"
	Unverified   ReleaseStatus = "unverified"
)

type Outcome string

const (
	OutcomeReady             Outcome = "ready"
	OutcomeFailedNoResources Outcome = "failed-no-resources"
	OutcomeFailedCleaned     Outcome = "failed-cleaned"
	OutcomeFailedIncomplete  Outcome = "failed-incomplete"
	OutcomeFailedUnknown     Outcome = "failed-unknown"
	// Normal closure is distinct from rollback after initialization failure.
	OutcomeClosed Outcome = "closed"
)

var (
	ErrBusy                = errors.New("lifecycle operation in progress")
	ErrOwned               = errors.New("committed session still owned")
	ErrUncertain           = errors.New("resource ownership unresolved")
	ErrStaleAttempt        = errors.New("stale initialization attempt")
	ErrInvalidState        = errors.New("operation invalid in current lifecycle state")
	ErrInvalidResource     = errors.New("resource requires an ID, known category and release callback")
	ErrDuplicateResource   = errors.New("resource ID already registered in this attempt")
	ErrNotValidated        = errors.New("prospective session has not been validated")
	ErrMissingSession      = errors.New("validated initialization has no registered MTP session")
	ErrInvalidValidator    = errors.New("validation callback is required")
	ErrMissingFailure      = errors.New("rollback requires a primary failure")
	ErrUnverifiedRelease   = errors.New("release was not positively acknowledged")
	ErrRejectedRelease     = errors.New("release was explicitly rejected")
	ErrInvalidRelease      = errors.New("invalid release disposition")
	ErrAttemptIDsExhausted = errors.New("initialization attempt IDs exhausted")
)

type CleanupError struct {
	ResourceID string
	Category   Category
	Err        error
}

// CallbackPanicError retains the panic value, including panic(nil). Formatting
// the error does not invoke methods on an arbitrary panic value.
type CallbackPanicError struct {
	Stage string
	Value interface{}
}

func (e *CallbackPanicError) Error() string {
	return fmt.Sprintf("%s callback panicked (%T)", e.Stage, e.Value)
}

type ResourceEvidence struct {
	ID       string
	Category Category
	Status   ReleaseStatus
}

// Evidence is an internal snapshot, not a native ABI or an IPC wire format.
// Empty Outcome denotes a nonterminal Empty/Acquiring/Releasing state.
// AttemptID is monotonic within one Owner, not a cross-process identifier.
// Errors preserve their Go identities. Maps and slices are detached copies.
// Mutating a snapshot cannot acknowledge cleanup in the owner.
type Evidence struct {
	Version             uint
	AttemptID           uint64
	State               State
	Outcome             Outcome
	CleanupAttempted    bool
	CleanupAcknowledged bool
	Registered          int
	Remaining           int
	RemainingByCategory map[Category]int
	Resources           []ResourceEvidence
	PrimaryError        error
	CleanupErrors       []CleanupError
}

type resource struct {
	id       string
	category Category
	release  ReleaseFunc
	status   ReleaseStatus
}

// Owner must not be copied after first use. Its zero value is an empty owner.
// One owner represents one complete session resource tree, not multiple devices.
// Reuse that owner across attempts; replacing an uncertain owner is not recovery.
type Owner struct {
	mu            sync.Mutex
	state         State
	attemptID     uint64
	resources     []*resource
	validating    bool
	validated     bool
	primary       error
	cleanupErrors []CleanupError
}

// Attempt is a fenced handle. Old handles cannot modify a subsequent attempt.
type Attempt struct {
	owner *Owner
	id    uint64
}

func (o *Owner) Begin() (*Attempt, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	switch o.state {
	case "", Empty, Closed:
	case Acquiring, Releasing:
		return nil, ErrBusy
	case Ready:
		return nil, ErrOwned
	default:
		return nil, ErrUncertain
	}
	if o.attemptID == ^uint64(0) {
		return nil, ErrAttemptIDsExhausted
	}
	o.attemptID++
	o.state = Acquiring
	o.resources = nil
	o.validating = false
	o.validated = false
	o.primary = nil
	o.cleanupErrors = nil
	return &Attempt{owner: o, id: o.attemptID}, nil
}

// Register is the sole ownership handoff. IDs are unique within an attempt;
// distinct IDs must represent distinct owned acquisitions, never aliases.
// A later acquisition invalidates earlier validation. During validation even
// registration is rejected, so validation and resource changes cannot overlap.
func (a *Attempt) Register(id string, category Category, release ReleaseFunc) error {
	if a == nil || a.owner == nil {
		return ErrStaleAttempt
	}
	o := a.owner
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := a.checkLocked(); err != nil {
		return err
	}
	if id == "" || releaseRank(category) < 0 || release == nil {
		return ErrInvalidResource
	}
	for _, r := range o.resources {
		if r.id == id {
			return ErrDuplicateResource
		}
	}
	o.resources = append(o.resources, &resource{
		id: id, category: category, release: release, status: NotAttempted,
	})
	o.validated = false
	return nil
}

// Validate runs the injected prospective-session checks. An error or panic
// automatically rolls back. The adapter must validate actual session readiness;
// this prototype cannot inspect USB/session objects. Nil is a programming error.
// Validation work must finish before the callback returns; submission is not
// validation. Callers must not hold external locks needed by their callbacks.
func (a *Attempt) Validate(validate func() error) (Evidence, error) {
	if a == nil || a.owner == nil {
		return Evidence{}, ErrStaleAttempt
	}
	o := a.owner
	o.mu.Lock()
	if err := a.checkLocked(); err != nil {
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, err
	}
	if validate == nil {
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, ErrInvalidValidator
	}
	o.validating = true
	o.validated = false
	o.mu.Unlock()

	err := callValidate(validate)
	o.mu.Lock()
	o.validating = false
	if err != nil {
		o.primary = err
		ordered := o.startCleanupLocked()
		o.mu.Unlock()
		return o.cleanup(ordered), err
	}
	o.validated = true
	e := o.snapshotLocked()
	o.mu.Unlock()
	return e, nil
}

// Commit only publishes ownership after validation. No native/global session is
// published here. The eventual adapter must perform its publication at commit.
func (a *Attempt) Commit() (Evidence, error) {
	if a == nil || a.owner == nil {
		return Evidence{}, ErrStaleAttempt
	}
	o := a.owner
	o.mu.Lock()
	defer o.mu.Unlock()
	if err := a.checkLocked(); err != nil {
		return o.snapshotLocked(), err
	}
	if !o.validated {
		return o.snapshotLocked(), ErrNotValidated
	}
	hasSession := false
	for _, r := range o.resources {
		if r.category == MTPSession {
			hasSession = true
			break
		}
	}
	if !hasSession {
		return o.snapshotLocked(), ErrMissingSession
	}
	o.state = Ready
	return o.snapshotLocked(), nil
}

// Fail rolls back a caller-reported acquisition/initialization failure. Callback
// cleanup errors are additional evidence and never replace the primary error.
func (a *Attempt) Fail(primary error) (Evidence, error) {
	if a == nil || a.owner == nil {
		return Evidence{}, ErrStaleAttempt
	}
	o := a.owner
	o.mu.Lock()
	if err := a.checkLocked(); err != nil {
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, err
	}
	if primary == nil {
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, ErrMissingFailure
	}
	o.primary = primary
	ordered := o.startCleanupLocked()
	o.mu.Unlock()
	return o.cleanup(ordered), primary
}

// Close releases a committed session. Acquisition must finish or explicitly
// Fail first. Repeated calls never retry a failed or unverified release.
func (o *Owner) Close() (Evidence, error) {
	o.mu.Lock()
	switch o.state {
	case Acquiring, Releasing:
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, ErrBusy
	case Uncertain:
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, ErrUncertain
	case "", Empty, Closed:
		o.state = Closed
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, nil
	case Ready:
		ordered := o.startCleanupLocked()
		o.mu.Unlock()
		e := o.cleanup(ordered)
		if e.State == Uncertain {
			return e, ErrUncertain
		}
		return e, nil
	default:
		e := o.snapshotLocked()
		o.mu.Unlock()
		return e, ErrInvalidState
	}
}

func (o *Owner) Snapshot() Evidence {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.snapshotLocked()
}

// checkLocked requires a.owner.mu. Lifecycle callbacks can reenter public
// methods: they get ErrBusy rather than waiting on themselves.
func (a *Attempt) checkLocked() error {
	o := a.owner
	if a.id != o.attemptID {
		return ErrStaleAttempt
	}
	if o.validating || o.state == Releasing {
		return ErrBusy
	}
	if o.state != Acquiring {
		return ErrInvalidState
	}
	return nil
}

// startCleanupLocked reserves cleanup before the lock is released. Release
// categories run child-first, with reverse registration order within a category.
// Because this prototype has no dependency graph, the FIRST unresolved release
// stops the entire pass: all remaining resources are conservatively retained.
// This may retain independent siblings, but never releases a possible parent of
// an unresolved child. Integration must use one owner for one dependency tree.
func (o *Owner) startCleanupLocked() []*resource {
	o.state = Releasing
	o.validated = false
	ordered := make([]*resource, 0, len(o.resources))
	for rank := releaseRank(BackgroundWorker); rank >= 0; rank-- {
		for i := len(o.resources) - 1; i >= 0; i-- {
			r := o.resources[i]
			if releaseRank(r.category) == rank {
				ordered = append(ordered, r)
			}
		}
	}
	return ordered
}

func (o *Owner) cleanup(ordered []*resource) Evidence {
	for _, r := range ordered {
		o.mu.Lock()
		r.status = InProgress
		o.mu.Unlock()

		result := callRelease(r.release)
		status, err := releaseStatus(result)
		o.mu.Lock()
		r.status = status
		if status != Released {
			o.cleanupErrors = append(o.cleanupErrors, CleanupError{
				ResourceID: r.id, Category: r.category, Err: err,
			})
			o.state = Uncertain
			e := o.snapshotLocked()
			o.mu.Unlock()
			return e
		}
		o.mu.Unlock()
	}
	o.mu.Lock()
	o.state = Closed
	e := o.snapshotLocked()
	o.mu.Unlock()
	return e
}

func releaseRank(category Category) int {
	switch category {
	case Context:
		return 0
	case Enumeration:
		return 1
	case DeviceReference:
		return 2
	case USBHandle:
		return 3
	case ClaimedInterface:
		return 4
	case MTPSession:
		return 5
	case BackgroundWorker:
		return 6
	default:
		return -1
	}
}

func callValidate(validate func() error) (err error) {
	returned := false
	defer func() {
		if !returned {
			err = &CallbackPanicError{Stage: "validation", Value: recover()}
		}
	}()
	err = validate()
	returned = true
	return err
}

func callRelease(release ReleaseFunc) (result ReleaseResult) {
	returned := false
	defer func() {
		if !returned {
			result = ReleaseResult{Err: &CallbackPanicError{
				Stage: "release", Value: recover(),
			}}
		}
	}()
	result = release()
	returned = true
	return result
}

func releaseStatus(result ReleaseResult) (ReleaseStatus, error) {
	switch result.Disposition {
	case ReleaseConfirmed:
		if result.Err == nil {
			return Released, nil
		}
		return Unverified, fmt.Errorf("release acknowledgement conflicts with error: %w", result.Err)
	case ReleaseRejected:
		if result.Err != nil {
			return Failed, result.Err
		}
		return Failed, ErrRejectedRelease
	case ReleaseUnknown:
		if result.Err != nil {
			return Unverified, result.Err
		}
		return Unverified, ErrUnverifiedRelease
	default:
		if result.Err != nil {
			return Unverified, fmt.Errorf("invalid release disposition: %w", result.Err)
		}
		return Unverified, ErrInvalidRelease
	}
}

// snapshotLocked computes evidence from actual registration/release records.
// Zero resources is a no-resource outcome, not an acknowledged cleanup attempt.
func (o *Owner) snapshotLocked() Evidence {
	state := o.state
	if state == "" {
		state = Empty
	}
	e := Evidence{
		Version: 1, AttemptID: o.attemptID, State: state,
		Registered: len(o.resources), PrimaryError: o.primary,
		RemainingByCategory: make(map[Category]int),
		Resources:           make([]ResourceEvidence, 0, len(o.resources)),
		CleanupErrors:       append([]CleanupError(nil), o.cleanupErrors...),
	}
	unknown := false
	for _, r := range o.resources {
		e.Resources = append(e.Resources, ResourceEvidence{ID: r.id, Category: r.category, Status: r.status})
		if r.status != Released {
			e.Remaining++
			e.RemainingByCategory[r.category]++
		}
		if r.status != NotAttempted {
			e.CleanupAttempted = true
		}
		if r.status == Unverified || r.status == InProgress {
			unknown = true
		}
	}
	e.CleanupAcknowledged = state == Closed && e.Registered > 0 && e.Remaining == 0
	switch state {
	case Ready:
		e.Outcome = OutcomeReady
	case Closed:
		switch {
		case o.primary == nil:
			e.Outcome = OutcomeClosed
		case e.Registered == 0:
			e.Outcome = OutcomeFailedNoResources
		default:
			e.Outcome = OutcomeFailedCleaned
		}
	case Uncertain:
		if unknown {
			e.Outcome = OutcomeFailedUnknown
		} else {
			e.Outcome = OutcomeFailedIncomplete
		}
	}
	return e
}
