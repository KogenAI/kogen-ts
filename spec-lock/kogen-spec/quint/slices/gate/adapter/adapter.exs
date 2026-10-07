# Replays selector picks against Kogen.Build.Selector. Excuse, ledger, and verdict
# have no pure function. Those steps stay last "not_replayed". Selector.rank is not
# the spec order; a differing winner is drift, not a reimplementation of §3.8.3.
ebin = System.get_env("KOGEN_EBIN") || Path.expand("~/Areas/Kogen/careful-rebuild/_build/dev/lib/kogen/ebin")
Code.prepend_path(ebin)
Code.ensure_loaded!(Kogen.Build.Selector)

defmodule Adapter do
  def init, do: %{offers: [], winner: "", last: "not_replayed"}

  def observe(s) do
    %{
      "last" => s.last,
      "ledger" => "",
      "verdict" => "",
      "landable" => false,
      "winner" => s.winner,
      "policy" => "",
      "excused" => %{},
      "items" => %{}
    }
  end

  def candidate(v) do
    %{
      rung: v["rung"],
      status: :failed,
      metrics: %{
        checks_green: false,
        failing_acceptance: v["blocking"],
        failing_tests: 0,
        diff_lines: v["diff"]
      }
    }
  end

  def handle(%{"op" => "reset"}, _), do: init()

  def handle(%{"op" => "apply", "event" => %{"tag" => "Offer", "value" => v}}, s) do
    %{s | offers: s.offers ++ [candidate(v)], last: "selector", winner: s.winner}
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Pick"}}, %{offers: []} = s) do
    %{s | last: "no_candidate"}
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Pick"}}, s) do
    best = Kogen.Build.Selector.best(s.offers)
    %{s | winner: best.rung, last: "selector"}
  end

  def handle(%{"op" => "apply"}, s), do: %{s | last: "not_replayed"}

  def loop(s) do
    case IO.binread(:stdio, :line) do
      :eof -> :ok
      {:error, _} -> :ok
      line ->
        s = handle(JSON.decode!(String.trim(line)), s)
        IO.binwrite(:stdio, [JSON.encode!(observe(s)), "\n"])
        loop(s)
    end
  end
end

Adapter.loop(Adapter.init())
