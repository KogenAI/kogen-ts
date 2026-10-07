//! Pure core: state, events, `apply`, `observe`. No I/O.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct Commit {
    pub id: String,
    /// "" = not a Kogen commit.
    pub slug: String,
}

#[derive(Clone, Debug)]
pub struct Approval {
    pub time: i64,
    pub id: i64,
}

#[derive(Clone, Debug)]
pub struct Run {
    pub slug: String,
    pub approval: i64,
    pub started: i64,
    /// running | landed | failed | parked
    pub status: String,
    /// "" | gate_red | base_moved | interrupted | reconciled
    pub reason: String,
    pub parent: String,
    pub landing: bool,
    pub alive: bool,
    pub interrupted: bool,
}

/// The Build in flight; phase "" = none.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Proc {
    pub rid: String,
    pub phase: String,
}

#[derive(Clone, Debug)]
pub struct State {
    pub base: Vec<Commit>,
    pub approvals: BTreeMap<String, Approval>,
    pub next_approval: i64,
    pub next_start: i64,
    pub claim: String,
    pub incoming: BTreeSet<String>,
    pub parked: BTreeSet<String>,
    pub runs: BTreeMap<String, Run>,
    pub proc: Proc,
    pub last: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "tag", content = "value")]
pub enum Event {
    Init,
    Approve { slug: String, time: i64 },
    Start(String),
    Gate(bool),
    Step,
    Crash,
    Interrupt,
    PushExternal(String),
    Recover,
}

#[derive(Serialize)]
pub struct RunView {
    pub slug: String,
    pub status: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct Obs {
    pub last: String,
    pub status: BTreeMap<String, String>,
    pub queue: Vec<String>,
    pub base: Vec<String>,
    pub claim: String,
    pub incoming: Vec<String>,
    pub parked: Vec<String>,
    pub runs: BTreeMap<String, RunView>,
    pub proc: Proc,
}

impl State {
    pub fn initial() -> State {
        State {
            base: vec![Commit { id: "root".into(), slug: String::new() }],
            approvals: BTreeMap::new(),
            next_approval: 1,
            next_start: 1,
            claim: String::new(),
            incoming: BTreeSet::new(),
            parked: BTreeSet::new(),
            runs: BTreeMap::new(),
            proc: Proc::default(),
            last: "ok".into(),
        }
    }

    fn tip(&self) -> &str {
        &self.base.last().expect("base is never empty").id
    }
    fn on_base(&self, id: &str) -> bool {
        self.base.iter().any(|c| c.id == id)
    }
    fn slug_landed(&self, slug: &str) -> bool {
        self.base.iter().any(|c| c.slug == slug)
    }
    fn err(mut self, code: &str) -> State {
        self.last = code.into();
        self
    }
    fn ok(mut self) -> State {
        self.last = "ok".into();
        self
    }

    /// Latest run of a slug = greatest start sequence.
    fn latest_run(&self, slug: &str) -> Option<(&String, &Run)> {
        self.runs
            .iter()
            .filter(|(_, r)| r.slug == slug)
            .max_by_key(|(_, r)| r.started)
    }

    /// Derived status of an approved slug (§2.11), first match wins, then the
    /// `interrupted` post-pass.
    fn derive(&self, slug: &str) -> &'static str {
        let latest = self.latest_run(slug);
        let current = latest
            .map(|(_, r)| Some(r.approval) == self.approvals.get(slug).map(|a| a.id))
            .unwrap_or(false);
        let status_is = |st: &str| latest.map_or(false, |(_, r)| r.status == st);
        let base = if self.slug_landed(slug) {
            "landed"
        } else if self.claim != "" && latest.map_or(false, |(id, _)| *id == self.claim) {
            "building"
        } else if current && status_is("parked") {
            "parked"
        } else if current && status_is("failed") {
            "failed"
        } else {
            "approved"
        };
        let is_interrupted = current
            && latest.map_or(false, |(_, r)| {
                (r.status == "running" && r.interrupted && !r.alive)
                    || (r.status == "failed" && r.reason == "interrupted")
            });
        if matches!(base, "approved" | "building" | "failed") && is_interrupted {
            "interrupted"
        } else {
            base
        }
    }

    /// Approved slugs ordered by (approval time, slug bytes).
    fn queue(&self) -> Vec<String> {
        let mut waiting: Vec<(&String, i64)> = self
            .approvals
            .iter()
            .filter(|(k, _)| self.derive(k) == "approved")
            .map(|(k, a)| (k, a.time))
            .collect();
        waiting.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.as_bytes().cmp(b.0.as_bytes())));
        waiting.into_iter().map(|(k, _)| k.clone()).collect()
    }

    /// Crash recovery: dead running runs become landed/reconciled or failed/interrupted;
    /// their incoming ref and the claim they own are dropped.
    fn recover(mut self) -> State {
        let dead: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, r)| r.status == "running" && !r.alive)
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            let landed = self.runs[&id].landing && self.on_base(&id);
            let rn = self.runs.get_mut(&id).unwrap();
            if landed {
                rn.status = "landed".into();
                rn.reason = "reconciled".into();
            } else {
                rn.status = "failed".into();
                rn.reason = "interrupted".into();
            }
            self.incoming.remove(&id);
            if self.claim == id {
                self.claim.clear();
            }
        }
        self
    }
}

fn approve(s: State, slug: String, time: i64) -> State {
    // The spec's slug universe is a modelling device. A real implementation accepts any
    // well-formed slug; the only "unknown" slug is the empty one (""), which the spec
    // reserves to mean "not a Kogen commit" and so can never name an intent.
    if slug.is_empty() {
        s.err("unknown_slug")
    } else if s.slug_landed(&slug) {
        s.err("already_landed")
    } else if s.approvals.contains_key(&slug) && s.derive(&slug) == "building" {
        s.err("intent_building")
    } else {
        let mut s = s;
        let id = s.next_approval;
        s.approvals.insert(slug, Approval { time, id });
        s.next_approval += 1;
        s.ok()
    }
}

fn start(s: State, id: String) -> State {
    if !s.proc.phase.is_empty() {
        return s.err("queue_running");
    }
    if s.runs.contains_key(&id) || s.on_base(&id) {
        return s.err("run_id_reused");
    }
    let mut r = s.recover(); // recovery persists even when start then fails
    let q = r.queue();
    if q.is_empty() {
        return r.err("nothing_to_build");
    }
    if !r.claim.is_empty() {
        return r.err("claim_held");
    }
    let slug = q[0].clone();
    let rn = Run {
        approval: r.approvals[&slug].id,
        started: r.next_start,
        status: "running".into(),
        reason: String::new(),
        parent: r.tip().to_string(),
        landing: false,
        alive: true,
        interrupted: false,
        slug,
    };
    r.runs.insert(id.clone(), rn);
    r.next_start += 1;
    r.claim = id.clone();
    r.proc = Proc { rid: id, phase: "building".into() };
    r.ok()
}

fn gate(mut s: State, pass: bool) -> State {
    if s.proc.phase != "building" {
        return s.err("not_building");
    }
    let id = s.proc.rid.clone();
    if pass {
        s.proc.phase = "built".into();
    } else {
        let rn = s.runs.get_mut(&id).unwrap();
        rn.status = "failed".into();
        rn.reason = "gate_red".into();
        s.claim.clear();
        s.proc = Proc::default();
    }
    s.ok()
}

fn advance(mut s: State) -> State {
    let id = s.proc.rid.clone();
    match s.proc.phase.as_str() {
        "built" => {
            s.runs.get_mut(&id).unwrap().landing = true;
            s.proc.phase = "recorded".into();
        }
        "recorded" => {
            s.incoming.insert(id);
            s.proc.phase = "pushed".into();
        }
        "pushed" => {
            let (parent, slug) = {
                let rn = &s.runs[&id];
                (rn.parent.clone(), rn.slug.clone())
            };
            if s.tip() == parent {
                s.base.push(Commit { id, slug });
                s.proc.phase = "based".into();
            } else {
                let rn = s.runs.get_mut(&id).unwrap();
                rn.status = "parked".into();
                rn.reason = "base_moved".into();
                s.incoming.remove(&id);
                s.parked.insert(id);
                s.claim.clear();
                s.proc = Proc::default();
            }
        }
        "based" => {
            s.incoming.remove(&id);
            s.proc.phase = "cleaned".into();
        }
        "cleaned" => {
            s.runs.get_mut(&id).unwrap().status = "landed".into();
            s.claim.clear();
            s.proc = Proc::default();
        }
        _ => return s.err("nothing_to_step"), // phase "" and also "building"
    }
    s.ok()
}

fn kill(mut s: State, sigterm: bool) -> State {
    if s.proc.phase.is_empty() {
        return s.err("no_process");
    }
    let id = s.proc.rid.clone();
    let rn = s.runs.get_mut(&id).unwrap();
    rn.alive = false;
    rn.interrupted = sigterm;
    s.proc = Proc::default();
    s.ok()
}

fn push_external(mut s: State, id: String) -> State {
    if s.on_base(&id) || s.runs.contains_key(&id) {
        return s.err("commit_exists");
    }
    s.base.push(Commit { id, slug: String::new() });
    s.ok()
}

pub fn apply(s: State, e: Event) -> State {
    match e {
        Event::Init => State::initial(),
        Event::Approve { slug, time } => approve(s, slug, time),
        Event::Start(id) => start(s, id),
        Event::Gate(pass) => gate(s, pass),
        Event::Step => advance(s),
        Event::Crash => kill(s, false),
        Event::Interrupt => kill(s, true),
        Event::PushExternal(id) => push_external(s, id),
        Event::Recover => s.recover().ok(),
    }
}

pub fn observe(s: &State) -> Obs {
    Obs {
        last: s.last.clone(),
        status: s.approvals.keys().map(|k| (k.clone(), s.derive(k).to_string())).collect(),
        queue: s.queue(),
        base: s.base.iter().map(|c| c.id.clone()).collect(),
        claim: s.claim.clone(),
        incoming: s.incoming.iter().cloned().collect(),
        parked: s.parked.iter().cloned().collect(),
        runs: s
            .runs
            .iter()
            .map(|(id, r)| {
                (
                    id.clone(),
                    RunView { slug: r.slug.clone(), status: r.status.clone(), reason: r.reason.clone() },
                )
            })
            .collect(),
        proc: s.proc.clone(),
    }
}
