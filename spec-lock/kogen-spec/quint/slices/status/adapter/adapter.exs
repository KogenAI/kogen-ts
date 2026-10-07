# xspec/1 adapter for the value-level status view. It calls Kogen's real dependency
# selector and text renderer. Lifecycle derivation from Git refs and run journals has
# no pure entry point; Raw events are projected to IntentStatus values here.
root = Path.expand("~/Areas/Kogen/careful-rebuild")
ebin_root = Path.join(root, "_build/dev/lib")

for app <- File.ls!(ebin_root) do
  ebin = Path.join([ebin_root, app, "ebin"])
  if File.dir?(ebin), do: Code.append_path(ebin)
end

defmodule Adapter do
  alias Kogen.Kernel.CLI.StatusOutput
  alias Kogen.Queue.IntentStatus
  alias Kogen.Queue.Selection
  alias Kogen.State.Event
  alias Kogen.State.Run
  alias Kogen.Queue.StateView

  @known ["alpha", "bravo", "charlie"]
  @sections ["Building", "Queued", "Blocked", "Failed", "Parked", "Interrupted", "Drafts", "Landed"]

  def init do
    %{cards: %{}, now: 0, older: 0, running: false, watch: "", watch_exit: 0, busy: 0, last: "ok"}
  end

  def handle(%{"op" => "reset"}, _), do: init()

  def handle(%{"op" => "apply", "event" => %{"tag" => tag} = event}, state),
    do: apply_event(tag, event["value"], state)

  def handle(_, state), do: %{state | last: "bad_event"}

  def observe(state) do
    statuses = prepared(state)
    queued = Kogen.Queue.Status.queued(statuses)
    view = %{statuses: statuses, queue: if(state.running, do: {:running, 4242}, else: :stopped)}
    text = StatusOutput.text(view, state.now)
    fields = rendered(text, statuses, queued, state)

    fields
    |> Map.put("last", state.last)
    |> Map.put("exit", state.watch_exit)
    |> Map.put("jsonDetail", false)
  end

  defp apply_event("Init", _, _), do: init()

  defp apply_event("Row", value, state) do
    slug = value["slug"]

    if slug in @known do
      card = %{
        slug: slug,
        status: value["status"],
        priority: value["priority"],
        at: value["at"],
        blocks: if(value["blocks"] == "", do: [], else: [value["blocks"]]),
        sched: value["sched"],
        started: value["started"],
        index: value["index"],
        reason: "",
        trailer: false
      }

      %{state | cards: Map.put(state.cards, slug, card), last: "ok"}
    else
      %{state | last: "bad_slug"}
    end
  end

  defp apply_event("Raw", value, state) do
    slug = value["slug"]

    if slug in @known do
      base = raw_status(value)
      interrupted? = interrupted?(value)
      status = if interrupted? and base in ["approved", "building", "failed"], do: "interrupted", else: base

      card = %{
        slug: slug,
        status: status,
        priority: value["priority"],
        at: value["at"],
        blocks: if(value["blocks"] == "", do: [], else: [value["blocks"]]),
        sched: "",
        started: 0,
        index: 0,
        reason: value["reason"],
        trailer: value["trailer"]
      }

      %{state | cards: Map.put(state.cards, slug, card), last: "ok"}
    else
      %{state | last: "bad_slug"}
    end
  end

  defp apply_event("Now", %{"t" => now}, state), do: %{state | now: now, last: "ok"}
  defp apply_event("Older", %{"n" => count}, state), do: %{state | older: count, last: "ok"}
  defp apply_event("Queue", %{"running" => running}, state), do: %{state | running: running, last: "ok"}
  defp apply_event("Agents", %{"busy" => busy}, state), do: %{state | busy: busy, last: "ok"}
  defp apply_event("Watch", %{"slug" => slug}, state),
    do: %{state | watch: slug, watch_exit: watch_exit(slug, state), last: "ok"}
  defp apply_event("Json", _, state), do: %{state | last: "ok"}
  defp apply_event("Derive", _, state), do: %{state | last: "ok"}
  defp apply_event(_, _, state), do: %{state | last: "bad_event"}

  defp raw_status(value) do
    cond do
      value["trailer"] -> "landed"
      value["claimed"] and value["runStatus"] == "running" -> "building"
      value["approved"] and value["same"] and value["runStatus"] == "parked" -> "parked"
      value["approved"] and value["same"] and value["runStatus"] == "failed" -> "failed"
      value["approved"] -> "approved"
      true -> "draft"
    end
  end

  defp interrupted?(%{"runStatus" => "running", "event" => "interrupted"} = value) do
    run = run(value, :running)
    event = %Event{event: "interrupted"}
    StateView.interrupted?(run, [event]) == {:ok, not value["alive"]}
  end

  defp interrupted?(%{"runStatus" => "failed", "reason" => "interrupted"} = value) do
    run = run(value, :failed)
    event = %Event{event: "finished", reason: "interrupted"}
    StateView.interrupted?(run, [event]) == {:ok, true}
  end

  defp interrupted?(_), do: false

  defp watch_exit("", state) do
    if not state.running and state.busy == 0 and
         not Enum.any?(prepared(state), &(&1.status == :building)), do: 0, else: -1
  end

  defp watch_exit(slug, state) do
    case Enum.find(prepared(state), &(&1.slug == slug)) do
      nil -> 2
      %{status: :landed} -> 0
      _ -> 1
    end
  end

  defp run(value, status) do
    approval = if value["same"], do: "approval", else: "older-approval"

    %Run{
      id: "status-run",
      dir: System.tmp_dir!(),
      slug: value["slug"],
      intent_sha256: String.duplicate("a", 64),
      target_branch: "main",
      approval_commit: approval,
      status: status,
      landing: nil,
      owner_os_pid: if(value["alive"], do: System.pid() |> String.to_integer(), else: nil)
    }
  end

  defp prepared(state) do
    cards =
      Enum.map(state.cards, fn {slug, card} ->
        raw = %IntentStatus{
          slug: slug,
          status: status_atom(card.status),
          run_id: nil,
          landed_sha: if(card.status == "landed", do: "00000000" <> slug, else: nil),
          approved_at: card.at,
          landed_index: if(card.status == "landed", do: card.index, else: nil),
          detail: detail(card),
          started_at: if(card.started == 0, do: nil, else: card.started),
          blocks_on: card.blocks,
          priority: card.priority,
          scheduling_error:
            if(card.sched == "", do: nil, else: String.replace_prefix(card.sched, "invalid scheduling metadata: ", ""))
        }

        {slug, raw}
      end)
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(&elem(&1, 1))

    older =
      for n <- 1..state.older, state.older > 0 do
        %IntentStatus{
          slug: "older-#{n}",
          status: :landed,
          run_id: nil,
          landed_sha: "00000000older",
          landed_index: 10 + n
        }
      end

    Selection.prepare(cards ++ older)
  end

  defp status_atom("approved"), do: :approved
  defp status_atom("building"), do: :building
  defp status_atom("failed"), do: :failed
  defp status_atom("parked"), do: :parked
  defp status_atom("interrupted"), do: :interrupted
  defp status_atom("landed"), do: :landed
  defp status_atom("blocked"), do: :blocked
  defp status_atom(_), do: :draft

  defp detail(%{status: "building"}), do: "starting"
  defp detail(%{status: status, reason: reason}) when status in ["failed", "parked", "interrupted"], do: reason
  defp detail(_), do: nil

  defp rendered(text, statuses, queued, state) do
    q = Enum.map(queued, & &1.slug)
    by_slug = Map.new(statuses, &{&1.slug, &1})
    first = List.first(queued)
    line = text |> String.split("\n", trim: true) |> List.first() || ""
    sections =
      text
      |> String.split("\n", trim: true)
      |> Enum.flat_map(fn row ->
        case Enum.find(@sections, fn title -> row == "#{title}:" or String.starts_with?(row, "#{title} (") end) do
          nil -> []
          title -> [title]
        end
      end)

    %{
      "alpha" => status_name(by_slug, "alpha"),
      "bravo" => status_name(by_slug, "bravo"),
      "charlie" => status_name(by_slug, "charlie"),
      "queue" => q,
      "whyA" => reason(by_slug, "alpha"),
      "whyB" => reason(by_slug, "bravo"),
      "whyC" => reason(by_slug, "charlie"),
      "sections" => sections,
      "earlier" => earlier(text),
      "landedShown" => landed_shown(text),
      "elapsed" => elapsed(text),
      "queueLine" => queue_line(line),
      "next" => if(first, do: first.slug, else: ""),
      "nextPriority" => if(first, do: first.priority, else: 0),
      "nextDependencies" => next_dependencies(first),
      "watchSlug" => state.watch,
      "watchStatus" => if(state.watch_exit == 2, do: "not_found", else: watch_status(state.watch, by_slug, queued, state.now)),
      "watchPosition" => Enum.find_index(q, &(&1 == state.watch)) || -1,
      "watchQueueSize" => length(q),
      "exit" => state.watch_exit,
      "jsonDetail" => false,
      "last" => state.last
    }
  end

  defp status_name(by_slug, slug) do
    case Map.get(by_slug, slug) do
      nil -> ""
      row -> Atom.to_string(row.status)
    end
  end

  defp reason(by_slug, slug) do
    case Map.get(by_slug, slug) do
      %{status: :blocked, detail: value} -> value || ""
      _ -> ""
    end
  end
  defp next_dependencies(nil), do: ""
  defp next_dependencies(%{blocks_on: []}), do: "no_dependencies"
  defp next_dependencies(_), do: "dependencies_delivered"

  defp watch_status("", _by_slug, _queued, _now), do: ""

  defp watch_status(slug, by_slug, queued, now) do
    case Map.get(by_slug, slug) do
      nil -> "not_found"
      row ->
        position = Enum.find_index(queued, &(&1.slug == slug))
        line = StatusOutput.intent_text(row, position, length(queued), now)
        line |> String.trim() |> String.replace_prefix("#{slug}: ", "") |> String.split(~r/[ ,;]/, trim: true) |> List.first()
    end
  end

  defp queue_line("Queue: running" <> _), do: "running"
  defp queue_line("Queue: stopped," <> _), do: "waiting"
  defp queue_line(_), do: "stopped"

  defp earlier(text) do
    case Regex.run(~r/and (\d+) earlier/, text) do
      [_, count] -> String.to_integer(count)
      _ -> 0
    end
  end

  defp landed_shown(text) do
    lines = String.split(text, "\n", trim: true)

    case Enum.find_index(lines, &String.starts_with?(&1, "Landed (")) do
      nil -> 0
      index ->
        lines
        |> Enum.drop(index + 1)
        |> Enum.take_while(&(not String.starts_with?(&1, "  and ")))
        |> length()
    end
  end

  defp elapsed(text) do
    case Regex.run(~r/Building:\n[^\n]*, \d+(s|m|h)/, text) do
      [_, unit] -> unit
      _ -> ""
    end
  end

  def loop(state) do
    case IO.binread(:stdio, :line) do
      :eof -> :ok
      {:error, _} -> :ok
      line ->
        state = handle(JSON.decode!(String.trim(line)), state)
        IO.binwrite(:stdio, [JSON.encode!(observe(state)), "\n"])
        loop(state)
    end
  end
end

Adapter.loop(Adapter.init())
