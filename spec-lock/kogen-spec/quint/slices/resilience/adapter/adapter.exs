# xspec/1 adapter over the REAL Kogen.Resilience.{Policy,Retry} (compiled from the read-only checkout).
# Only what the real pure core decides is observed; everything it does not model reports kind "unsupported".
# KOGEN_POLICY=aligned bends the two Policy knobs the spec disagrees on (max_attempts, overload_fallback_after).
src = System.get_env("KOGEN_SRC") || Path.expand("~/Areas/Kogen/careful-rebuild/lib/kogen")
Code.require_file(Path.join(src, "resilience/policy.ex"))
Code.require_file(Path.join(src, "resilience/retry.ex"))

defmodule Adapter do
  alias Kogen.Resilience.{Policy, Retry}
  @first_byte 120_000
  @idle 120_000
  @total 600_000

  def init, do: %{retry: nil, policy: nil, model: "", dec: dec("", 0, "", ""), consec: 0, attempts: 0, last: "ok"}
  defp dec(k, d, m, r), do: %{"kind" => k, "delay_ms" => d, "model" => m, "reason" => r}

  def policy(%{"model" => m, "fallback" => f}, role) do
    base = %Policy{fallbacks: %{role => [{f, "medium"}]}}
    if System.get_env("KOGEN_POLICY") == "aligned",
      do: %{base | max_attempts: 1_000_000, overload_fallback_after: 3},
      else: base
  end

  def handle(%{"op" => "reset"}, _), do: init()

  def handle(%{"op" => "apply", "event" => %{"tag" => "Stage", "value" => v}}, s) do
    role = Policy.role(String.to_atom(v["name"]))
    %{init() | policy: policy(v, role), model: v["model"], retry: {role, v["model"]}}
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Request"}}, %{retry: {role, m}} = s),
    do: %{s | retry: Retry.new(role, {m, "medium"}), dec: dec("", 0, "", ""), consec: 0, attempts: 0, model: m}

  def handle(%{"op" => "apply", "event" => %{"tag" => "Request"}}, %{retry: %Retry{role: role} = r} = s),
    do: %{s | retry: Retry.new(role, r.model), dec: dec("", 0, "", ""), consec: 0, attempts: 0}

  def handle(%{"op" => "apply", "event" => %{"tag" => "Attempt", "value" => a}}, %{retry: %Retry{} = r} = s) do
    missed = a["first_byte_ms"] > @first_byte or a["max_gap_ms"] > @idle or a["elapsed_ms"] > @total
    class = if missed, do: "timeout", else: a["result"]
    s = %{s | attempts: s.attempts + 1}

    if class == "ok" do
      %{s | dec: dec("success", 0, elem(r.model, 0), "")}
    else
      atom = String.to_atom(class)

      case Retry.next(s.policy, r, atom, :infinity) do
        :stop ->
          %{s | dec: dec("stop", 0, elem(r.model, 0), "provider/" <> class)}

        {:retry, next, delay, fb} ->
          ceiling = min(s.policy.backoff_base_ms * Integer.pow(2, min(r.attempt - 1, 20)), s.policy.backoff_max_ms)
          # real code jitters inside [ceiling/2, ceiling]; the spec says exactly the ladder value
          d = if delay > 0 and delay >= div(ceiling, 2) and delay <= ceiling, do: ceiling, else: delay
          kind = if fb, do: "switch", else: "retry"
          %{s | retry: next, consec: next.overloads, model: elem(next.model, 0), dec: dec(kind, d, elem(next.model, 0), class)}
      end
    end
  end

  def handle(%{"op" => "apply"}, s), do: %{s | dec: dec("unsupported", 0, "", "")}

  def observe(s) do
    m = case s.retry do
      %Retry{model: {n, _}} -> n
      _ -> s.model
    end
    %{"last" => s.last, "model" => m, "consec" => s.consec, "attempts" => s.attempts, "decision" => s.dec}
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
