defmodule Landing do
  @moduledoc """
  Pure core of the landing state machine: `apply/2` and `observe/1`.
  Faithful port of spec/landing.qnt. No I/O.
  """

  defmodule Commit do
    @enforce_keys [:id, :slug]
    defstruct [:id, :slug]
  end

  defmodule Run do
    @enforce_keys [:slug, :approval, :started, :parent]
    defstruct [:slug, :approval, :started, :parent,
               status: "running", reason: "", landing: false, alive: true, interrupted: false]
  end

  defmodule Proc do
    defstruct rid: "", phase: ""
  end

  defmodule State do
    defstruct base: [%Landing.Commit{id: "root", slug: ""}],
              approvals: %{},
              next_approval: 1,
              next_start: 1,
              claim: "",
              incoming: MapSet.new(),
              parked: MapSet.new(),
              runs: %{},
              proc: %Landing.Proc{},
              last: "ok"
  end

  @type event ::
          :init
          | {:approve, String.t(), integer()}
          | {:start, String.t()}
          | {:gate, boolean()}
          | :step
          | :crash
          | :interrupt
          | {:push_external, String.t()}
          | :recover

  def initial, do: %State{}

  # ---------- helpers ----------
  defp tip(%State{base: base}), do: List.last(base).id
  defp on_base?(%State{base: base}, id), do: Enum.any?(base, &(&1.id == id))
  defp slug_landed?(%State{base: base}, slug), do: Enum.any?(base, &(&1.slug == slug))
  defp err(s, code), do: %{s | last: code}
  defp put_run(s, id, r), do: %{s | runs: Map.put(s.runs, id, r)}
  defp no_proc, do: %Proc{}

  # latest run of a slug = greatest start sequence; nil if none
  defp latest_run(s, slug) do
    s.runs
    |> Enum.filter(fn {_id, r} -> r.slug == slug end)
    |> Enum.max_by(fn {_id, r} -> r.started end, fn -> nil end)
    |> case do
      nil -> nil
      {id, _} -> id
    end
  end

  # §2.11, first match wins, then the `interrupted` post-pass
  def derive(s, slug) do
    latest = latest_run(s, slug)
    r = latest && Map.fetch!(s.runs, latest)
    current = r != nil and r.approval == Map.fetch!(s.approvals, slug).id

    base =
      cond do
        slug_landed?(s, slug) -> "landed"
        latest != nil and s.claim != "" and s.claim == latest -> "building"
        current and r.status == "parked" -> "parked"
        current and r.status == "failed" -> "failed"
        true -> "approved"
      end

    interrupted? =
      current and
        ((r.status == "running" and r.interrupted and not r.alive) or
           (r.status == "failed" and r.reason == "interrupted"))

    if base in ["approved", "building", "failed"] and interrupted?, do: "interrupted", else: base
  end

  # queue = approved slugs ordered by (approval time, slug bytes)
  def queue(s) do
    s.approvals
    |> Enum.filter(fn {slug, _} -> derive(s, slug) == "approved" end)
    |> Enum.sort_by(fn {slug, a} -> {a.time, slug} end)
    |> Enum.map(&elem(&1, 0))
  end

  # ---------- recovery ----------
  defp recover(s) do
    s.runs
    |> Enum.filter(fn {_id, r} -> r.status == "running" and not r.alive end)
    |> Enum.reduce(s, fn {id, rn}, acc ->
      fixed =
        if rn.landing and on_base?(acc, id),
          do: %{rn | status: "landed", reason: "reconciled"},
          else: %{rn | status: "failed", reason: "interrupted"}

      %{
        acc
        | runs: Map.put(acc.runs, id, fixed),
          incoming: MapSet.delete(acc.incoming, id),
          claim: if(acc.claim == id, do: "", else: acc.claim)
      }
    end)
  end

  # ---------- transitions ----------
  # Decision: any non-empty slug is accepted. "" is the spec's "not a Kogen commit"
  # marker (the root and external commits carry it), so it cannot be a real slug and is
  # the one case that still yields `unknown_slug`.
  defp approve(s, "", _time), do: err(s, "unknown_slug")

  defp approve(s, slug, time) do
    cond do
      slug_landed?(s, slug) -> err(s, "already_landed")
      Map.has_key?(s.approvals, slug) and derive(s, slug) == "building" -> err(s, "intent_building")
      true ->
        %{s | approvals: Map.put(s.approvals, slug, %{time: time, id: s.next_approval}),
              next_approval: s.next_approval + 1, last: "ok"}
    end
  end

  # Not in the spec: "" is the "absent" marker for claim/proc.rid, so it cannot be an id.
  defp start(s, ""), do: err(s, "invalid_id")

  defp start(s, id) do
    cond do
      s.proc.phase != "" ->
        err(s, "queue_running")

      Map.has_key?(s.runs, id) or on_base?(s, id) ->
        err(s, "run_id_reused")

      true ->
        r = recover(s)

        case queue(r) do
          [] ->
            %{r | last: "nothing_to_build"}

          [slug | _] ->
            if r.claim != "" do
              %{r | last: "claim_held"}
            else
              rn = %Run{slug: slug, approval: Map.fetch!(r.approvals, slug).id,
                        started: r.next_start, parent: tip(r)}

              %{put_run(r, id, rn) | next_start: r.next_start + 1, claim: id,
                proc: %Proc{rid: id, phase: "building"}, last: "ok"}
            end
        end
    end
  end

  defp gate(%State{proc: %Proc{phase: "building", rid: id}} = s, pass) do
    if pass do
      %{s | proc: %Proc{rid: id, phase: "built"}, last: "ok"}
    else
      s
      |> put_run(id, %{Map.fetch!(s.runs, id) | status: "failed", reason: "gate_red"})
      |> Map.merge(%{claim: "", proc: no_proc(), last: "ok"})
    end
  end

  defp gate(s, _pass), do: err(s, "not_building")

  defp advance(%State{proc: %Proc{rid: id, phase: ph}} = s) when ph != "" do
    rn = Map.fetch!(s.runs, id)

    case ph do
      "built" ->
        %{put_run(s, id, %{rn | landing: true}) | proc: %Proc{rid: id, phase: "recorded"}, last: "ok"}

      "recorded" ->
        %{s | incoming: MapSet.put(s.incoming, id), proc: %Proc{rid: id, phase: "pushed"}, last: "ok"}

      "pushed" ->
        if tip(s) == rn.parent do
          %{s | base: s.base ++ [%Commit{id: id, slug: rn.slug}],
                proc: %Proc{rid: id, phase: "based"}, last: "ok"}
        else
          %{put_run(s, id, %{rn | status: "parked", reason: "base_moved"})
            | parked: MapSet.put(s.parked, id), incoming: MapSet.delete(s.incoming, id),
              claim: "", proc: no_proc(), last: "ok"}
        end

      "based" ->
        %{s | incoming: MapSet.delete(s.incoming, id), proc: %Proc{rid: id, phase: "cleaned"}, last: "ok"}

      "cleaned" ->
        %{put_run(s, id, %{rn | status: "landed"}) | claim: "", proc: no_proc(), last: "ok"}

      _ ->
        err(s, "nothing_to_step")
    end
  end

  defp advance(s), do: err(s, "nothing_to_step")

  defp kill(%State{proc: %Proc{phase: ""}} = s, _sigterm), do: err(s, "no_process")

  defp kill(%State{proc: %Proc{rid: id}} = s, sigterm) do
    put_run(s, id, %{Map.fetch!(s.runs, id) | alive: false, interrupted: sigterm})
    |> Map.merge(%{proc: no_proc(), last: "ok"})
  end

  defp push_external(s, id) do
    cond do
      id == "" -> err(s, "invalid_id")
      on_base?(s, id) or Map.has_key?(s.runs, id) -> err(s, "commit_exists")
      true -> %{s | base: s.base ++ [%Commit{id: id, slug: ""}], last: "ok"}
    end
  end

  @spec apply(State.t(), event()) :: State.t()
  def apply(_s, :init), do: initial()
  def apply(s, {:approve, slug, time}), do: approve(s, slug, time)
  def apply(s, {:start, id}), do: start(s, id)
  def apply(s, {:gate, pass}), do: gate(s, pass)
  def apply(s, :step), do: advance(s)
  def apply(s, :crash), do: kill(s, false)
  def apply(s, :interrupt), do: kill(s, true)
  def apply(s, {:push_external, id}), do: push_external(s, id)
  def apply(s, :recover), do: %{recover(s) | last: "ok"}

  # ---------- observation (JSON-ready: string keys, sets as lists) ----------
  def observe(s) do
    %{
      "last" => s.last,
      "status" => Map.new(s.approvals, fn {slug, _} -> {slug, derive(s, slug)} end),
      "queue" => queue(s),
      "base" => Enum.map(s.base, & &1.id),
      "claim" => s.claim,
      "incoming" => s.incoming |> MapSet.to_list() |> Enum.sort(),
      "parked" => s.parked |> MapSet.to_list() |> Enum.sort(),
      "runs" =>
        Map.new(s.runs, fn {id, r} ->
          {id, %{"slug" => r.slug, "status" => r.status, "reason" => r.reason}}
        end),
      "proc" => %{"rid" => s.proc.rid, "phase" => s.proc.phase}
    }
  end
end
