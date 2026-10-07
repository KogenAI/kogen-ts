//! Adapter: JSON lines over stdin/stdout (xspec/1). See PROTOCOL.md.

mod core;

use core::{apply, observe, Event, State};
use serde::Deserialize;
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Reset,
    Apply { event: Event },
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    let mut state = State::initial();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(Request::Reset) => {
                state = State::initial();
                serde_json::to_string(&observe(&state))
            }
            Ok(Request::Apply { event }) => {
                state = apply(state, event);
                serde_json::to_string(&observe(&state))
            }
            Err(e) => {
                eprintln!("bad request {line:?}: {e}");
                Ok(format!("{{\"error\":{}}}", serde_json::to_string(&e.to_string())?))
            }
        };
        writeln!(out, "{}", reply?)?;
        out.flush()?;
    }
    Ok(())
}
