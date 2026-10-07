// Adapter for the xspec/1 protocol: JSON lines on stdin, one JSON line per request on stdout.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"landing/core"
)

type request struct {
	Op    string `json:"op"`
	Event *struct {
		Tag   string          `json:"tag"`
		Value json.RawMessage `json:"value"`
	} `json:"event"`
}

func decodeEvent(tag string, value json.RawMessage) (core.Event, error) {
	switch tag {
	case "Step":
		return core.Step{}, nil
	case "Crash":
		return core.Crash{}, nil
	case "Interrupt":
		return core.Interrupt{}, nil
	case "Recover":
		return core.Recover{}, nil
	case "Init":
		return core.Init{}, nil
	case "Approve":
		var v struct {
			Slug string `json:"slug"`
			Time int64  `json:"time"`
		}
		if err := json.Unmarshal(value, &v); err != nil {
			return nil, err
		}
		return core.Approve{Slug: v.Slug, Time: v.Time}, nil
	case "Start":
		var id string
		if err := json.Unmarshal(value, &id); err != nil {
			return nil, err
		}
		return core.Start{ID: id}, nil
	case "PushExternal":
		var id string
		if err := json.Unmarshal(value, &id); err != nil {
			return nil, err
		}
		return core.PushExternal{ID: id}, nil
	case "Gate":
		var pass bool
		if err := json.Unmarshal(value, &pass); err != nil {
			return nil, err
		}
		return core.Gate{Pass: pass}, nil
	}
	return nil, fmt.Errorf("unknown event tag %q", tag)
}

func handle(state *core.State, line []byte) (any, error) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		return nil, err
	}
	switch req.Op {
	case "reset":
		*state = core.Initial()
	case "apply":
		if req.Event == nil {
			return nil, errors.New("apply without event")
		}
		ev, err := decodeEvent(req.Event.Tag, req.Event.Value)
		if err != nil {
			return nil, err
		}
		*state = core.Apply(*state, ev)
	default:
		return nil, fmt.Errorf("unknown op %q", req.Op)
	}
	return core.Observe(*state), nil
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	state := core.Initial()
	for {
		line, err := in.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			resp, herr := handle(&state, line)
			if herr != nil {
				fmt.Fprintln(os.Stderr, "adapter:", herr)
				resp = map[string]string{"error": herr.Error()}
			}
			b, _ := json.Marshal(resp)
			out.Write(b)
			out.WriteByte('\n')
			out.Flush()
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				fmt.Fprintln(os.Stderr, "adapter:", err)
			}
			return
		}
	}
}
