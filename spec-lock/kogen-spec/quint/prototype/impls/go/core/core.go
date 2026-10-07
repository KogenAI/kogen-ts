// Package core is the pure implementation of the landing spec: Apply and Observe
// have no I/O and never mutate their arguments.
package core

import (
	"cmp"
	"slices"
)

type Commit struct {
	ID   string
	Slug string // "" = not a Kogen commit
}

type Approval struct {
	Time int64
	ID   int
}

type Run struct {
	Slug        string
	Approval    int
	Started     int
	Status      string // running | landed | failed | parked
	Reason      string // "" | gate_red | base_moved | interrupted | reconciled
	Parent      string // base tip when the Build started
	Landing     bool
	Alive       bool
	Interrupted bool
}

type Proc struct {
	RID   string `json:"rid"`
	Phase string `json:"phase"` // "" | building | built | recorded | pushed | based | cleaned
}

type Set map[string]struct{}

type State struct {
	Base         []Commit
	Approvals    map[string]Approval
	NextApproval int
	NextStart    int
	Claim        string
	Incoming     Set
	Parked       Set
	Runs         map[string]Run
	Proc         Proc
	Last         string
}

// Events.
type Event interface{ isEvent() }

type (
	Init    struct{}
	Approve struct {
		Slug string
		Time int64
	}
	Start        struct{ ID string }
	Gate         struct{ Pass bool }
	Step         struct{}
	Crash        struct{}
	Interrupt    struct{}
	PushExternal struct{ ID string }
	Recover      struct{}
)

func (Init) isEvent()         {}
func (Approve) isEvent()      {}
func (Start) isEvent()        {}
func (Gate) isEvent()         {}
func (Step) isEvent()         {}
func (Crash) isEvent()        {}
func (Interrupt) isEvent()    {}
func (PushExternal) isEvent() {}
func (Recover) isEvent()      {}

type RunView struct {
	Slug   string `json:"slug"`
	Status string `json:"status"`
	Reason string `json:"reason"`
}

type Obs struct {
	Last     string             `json:"last"`
	Status   map[string]string  `json:"status"`
	Queue    []string           `json:"queue"`
	Base     []string           `json:"base"`
	Claim    string             `json:"claim"`
	Incoming []string           `json:"incoming"`
	Parked   []string           `json:"parked"`
	Runs     map[string]RunView `json:"runs"`
	Proc     Proc               `json:"proc"`
}

// Initial returns the initial state.
func Initial() State {
	return State{
		Base:         []Commit{{ID: "root"}},
		Approvals:    map[string]Approval{},
		NextApproval: 1,
		NextStart:    1,
		Incoming:     Set{},
		Parked:       Set{},
		Runs:         map[string]Run{},
		Last:         "ok",
	}
}

func (s State) clone() State {
	c := s
	c.Base = slices.Clone(s.Base)
	c.Approvals = cloneMap(s.Approvals)
	c.Incoming = cloneMap(s.Incoming)
	c.Parked = cloneMap(s.Parked)
	c.Runs = cloneMap(s.Runs)
	return c
}

func cloneMap[K comparable, V any](m map[K]V) map[K]V {
	c := make(map[K]V, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}

// ---------- helpers ----------

func (s *State) tip() string { return s.Base[len(s.Base)-1].ID }

func (s *State) onBase(id string) bool {
	return slices.ContainsFunc(s.Base, func(c Commit) bool { return c.ID == id })
}

func (s *State) slugLanded(slug string) bool {
	return slices.ContainsFunc(s.Base, func(c Commit) bool { return c.Slug == slug })
}

func (s *State) fail(code string) { s.Last = code }

// latestRun is the run of slug with the greatest start sequence, "" if none.
func (s *State) latestRun(slug string) string {
	best := ""
	for id, r := range s.Runs {
		if r.Slug == slug && (best == "" || r.Started > s.Runs[best].Started) {
			best = id
		}
	}
	return best
}

// derive is §2.11: first match wins, then the `interrupted` post-pass.
func (s *State) derive(slug string) string {
	latest := s.latestRun(slug)
	var r Run
	current := false
	if latest != "" {
		r = s.Runs[latest]
		current = r.Approval == s.Approvals[slug].ID
	}
	var base string
	switch {
	case s.slugLanded(slug):
		base = "landed"
	case s.Claim != "" && s.Claim == latest:
		base = "building"
	case current && r.Status == "parked":
		base = "parked"
	case current && r.Status == "failed":
		base = "failed"
	default:
		base = "approved"
	}
	interrupted := current &&
		((r.Status == "running" && r.Interrupted && !r.Alive) ||
			(r.Status == "failed" && r.Reason == "interrupted"))
	if interrupted && (base == "approved" || base == "building" || base == "failed") {
		return "interrupted"
	}
	return base
}

// queue = approved slugs ordered by (approval time, slug in byte order).
func (s *State) queue() []string {
	q := []string{}
	for slug := range s.Approvals {
		if s.derive(slug) == "approved" {
			q = append(q, slug)
		}
	}
	slices.SortFunc(q, func(a, b string) int {
		return cmp.Or(cmp.Compare(s.Approvals[a].Time, s.Approvals[b].Time), cmp.Compare(a, b))
	})
	return q
}

// ---------- recovery ----------

// recover settles every dead running run: landed/reconciled if its Landing was
// recorded and its commit is on the base, else failed/interrupted; releases its
// incoming ref and the claim it owns.
func (s *State) recover() {
	for id, rn := range s.Runs {
		if rn.Status != "running" || rn.Alive {
			continue
		}
		if rn.Landing && s.onBase(id) {
			rn.Status, rn.Reason = "landed", "reconciled"
		} else {
			rn.Status, rn.Reason = "failed", "interrupted"
		}
		s.Runs[id] = rn
		delete(s.Incoming, id)
		if s.Claim == id {
			s.Claim = ""
		}
	}
}

// ---------- transitions ----------

func (s *State) approve(slug string, time int64) {
	switch {
	case slug == "": // "" is the spec's "not a Kogen slug" sentinel
		s.fail("unknown_slug")
	case s.slugLanded(slug):
		s.fail("already_landed")
	case s.hasApproval(slug) && s.derive(slug) == "building":
		s.fail("intent_building")
	default:
		s.Approvals[slug] = Approval{Time: time, ID: s.NextApproval}
		s.NextApproval++
		s.Last = "ok"
	}
}

func (s *State) hasApproval(slug string) bool { _, ok := s.Approvals[slug]; return ok }

func (s *State) start(id string) {
	if s.Proc.Phase != "" {
		s.fail("queue_running")
		return
	}
	if _, used := s.Runs[id]; used || s.onBase(id) {
		s.fail("run_id_reused")
		return
	}
	s.recover() // recovery is kept even when nothing starts
	q := s.queue()
	if len(q) == 0 {
		s.Last = "nothing_to_build"
		return
	}
	if s.Claim != "" {
		s.Last = "claim_held"
		return
	}
	slug := q[0]
	s.Runs[id] = Run{
		Slug: slug, Approval: s.Approvals[slug].ID, Started: s.NextStart,
		Status: "running", Parent: s.tip(), Alive: true,
	}
	s.NextStart++
	s.Claim = id
	s.Proc = Proc{RID: id, Phase: "building"}
	s.Last = "ok"
}

func (s *State) gate(pass bool) {
	if s.Proc.Phase != "building" {
		s.fail("not_building")
		return
	}
	id := s.Proc.RID
	if pass {
		s.Proc.Phase = "built"
	} else {
		rn := s.Runs[id]
		rn.Status, rn.Reason = "failed", "gate_red"
		s.Runs[id] = rn
		s.Claim = ""
		s.Proc = Proc{}
	}
	s.Last = "ok"
}

func (s *State) advance() {
	id := s.Proc.RID
	rn := s.Runs[id]
	switch s.Proc.Phase {
	case "built": // record Landing before anything moves
		rn.Landing = true
		s.Runs[id] = rn
		s.Proc.Phase = "recorded"
	case "recorded": // push refs/kogen/incoming/<run>
		s.Incoming[id] = struct{}{}
		s.Proc.Phase = "pushed"
	case "pushed": // CAS fast-forward from the expected parent
		if s.tip() == rn.Parent {
			s.Base = append(s.Base, Commit{ID: id, Slug: rn.Slug})
			s.Proc.Phase = "based"
		} else { // base moved: park the candidate, release everything
			rn.Status, rn.Reason = "parked", "base_moved"
			s.Runs[id] = rn
			s.Parked[id] = struct{}{}
			delete(s.Incoming, id)
			s.Claim = ""
			s.Proc = Proc{}
		}
	case "based":
		delete(s.Incoming, id)
		s.Proc.Phase = "cleaned"
	case "cleaned":
		rn.Status = "landed"
		s.Runs[id] = rn
		s.Claim = ""
		s.Proc = Proc{}
	default: // "" and "building" (the latter only moves via Gate)
		s.fail("nothing_to_step")
		return
	}
	s.Last = "ok"
}

func (s *State) kill(sigterm bool) {
	if s.Proc.Phase == "" {
		s.fail("no_process")
		return
	}
	id := s.Proc.RID
	rn := s.Runs[id]
	rn.Alive, rn.Interrupted = false, sigterm
	s.Runs[id] = rn
	s.Proc = Proc{}
	s.Last = "ok"
}

func (s *State) pushExternal(id string) {
	if _, isRun := s.Runs[id]; isRun || s.onBase(id) {
		s.fail("commit_exists")
		return
	}
	s.Base = append(s.Base, Commit{ID: id})
	s.Last = "ok"
}

// Apply returns the state after event e; s is not modified.
func Apply(s State, e Event) State {
	if _, ok := e.(Init); ok {
		return Initial()
	}
	n := s.clone()
	switch e := e.(type) {
	case Approve:
		n.approve(e.Slug, e.Time)
	case Start:
		n.start(e.ID)
	case Gate:
		n.gate(e.Pass)
	case Step:
		n.advance()
	case Crash:
		n.kill(false)
	case Interrupt:
		n.kill(true)
	case PushExternal:
		n.pushExternal(e.ID)
	case Recover:
		n.recover()
		n.Last = "ok"
	}
	return n
}

func sortedKeys(m Set) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	slices.Sort(ks)
	return ks
}

// Observe projects the state onto the observation the harness compares.
func Observe(s State) Obs {
	o := Obs{
		Last:     s.Last,
		Status:   make(map[string]string, len(s.Approvals)),
		Queue:    s.queue(),
		Base:     make([]string, 0, len(s.Base)),
		Claim:    s.Claim,
		Incoming: sortedKeys(s.Incoming),
		Parked:   sortedKeys(s.Parked),
		Runs:     make(map[string]RunView, len(s.Runs)),
		Proc:     s.Proc,
	}
	for slug := range s.Approvals {
		o.Status[slug] = s.derive(slug)
	}
	for _, c := range s.Base {
		o.Base = append(o.Base, c.ID)
	}
	for id, r := range s.Runs {
		o.Runs[id] = RunView{Slug: r.Slug, Status: r.Status, Reason: r.Reason}
	}
	return o
}
