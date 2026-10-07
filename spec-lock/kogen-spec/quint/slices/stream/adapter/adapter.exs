# xspec/1 adapter. Retry decisions, interrupted-turn recovery, and checkpoints come from
# pure Kogen modules in the read-only checkout. The adapter covers Retry and Recovery;
# credential refresh and the outer Build pause still require provider/runner effects.
src = System.get_env("KOGEN_SRC") || Path.expand("~/Areas/Kogen/careful-rebuild/lib/kogen")
ebin = Path.expand("~/Areas/Kogen/careful-rebuild/_build/dev/lib/kogen/ebin")
Code.append_path(ebin)
Code.require_file(Path.join(src, "resilience/policy.ex"))
Code.require_file(Path.join(src, "resilience/retry.ex"))

defmodule Adapter do
  alias Kogen.Resilience.{Policy, Retry}

  @waits [0, 300_000, 86_100_000, 86_400_000]
  @roles ["builder", "planner"]
  @models ["luna", "sol"]
  @modes ["build", "shape"]
  @checkpoint_text ~s({"obligations":"keep","findings":"found","investigation":"looked","ruled_out":"no","next_steps":"finish"})

  def init do
    %{
      "last" => "ok",
      "phase" => "idle",
      "mode" => "",
      "role" => "",
      "model" => "",
      "fallbackOn" => false,
      "bounded" => false,
      "wall" => 0,
      "attempt" => 0,
      "overloads" => 0,
      "refreshed" => false,
      "waited" => 0,
      "decision" => "",
      "delay" => 0,
      "reason" => "",
      "continued" => false,
      "queued" => false,
      "exit" => 0,
      "checkpoint" => "",
      "continuations" => 0,
      "failed" => false,
      :retry => nil,
      :policy => nil
    }
  end

  def observe(s), do: Map.drop(s, [:retry, :policy])

  def handle(%{"op" => "reset"}, _), do: init()
  def handle(%{"op" => "apply", "event" => %{"tag" => tag} = event}, s), do: apply_event(tag, event["value"], s)
  def handle(_, s), do: %{s | "last" => "bad_event"}

  defp apply_event("Init", _, _), do: init()

  defp apply_event("Open", v, s) do
    cond do
      s["phase"] == "open" ->
        %{s | "last" => "bad_open"}

      v["role"] not in @roles or v["model"] not in @models or v["mode"] not in @modes ->
        %{s | "last" => "bad_open"}

      true ->
        %{
          s
          | "phase" => "open",
            "mode" => v["mode"],
            "role" => v["role"],
            "model" => v["model"],
            "fallbackOn" => v["fallbackOn"],
            "bounded" => v["bounded"],
            "wall" => v["wall"],
            "attempt" => 1,
            "overloads" => 0,
            "refreshed" => false,
            "decision" => "",
            "delay" => 0,
            "reason" => "",
            "continued" => false,
            "checkpoint" => "",
            "queued" => true,
            "exit" => 0,
            "last" => "ok",
            "failed" => false,
            :retry => Retry.new(String.to_atom(v["role"]), model_tuple(v["model"])),
            :policy => %Policy{model_fallback: v["fallbackOn"]}
        }
    end
  end

  defp apply_event("Result", v, %{"phase" => "open"} = s) do
    case klass(v["kind"], v["items"]) do
      :bad ->
        %{s | "last" => "bad_result"}

      :ok ->
        %{s | "phase" => "idle", "decision" => "success", "delay" => 0, "reason" => "", "continued" => false, "exit" => 0, "last" => "ok"}

      :incomplete ->
        case Retry.next(s[:policy], s[:retry], :incomplete, remaining(s)) do
          :stop ->
            %{s | "phase" => "idle", "decision" => "incomplete", "delay" => 0, "reason" => "", "continued" => false, "exit" => 0, "last" => "ok"}

          {:retry, next, delay, fb} ->
            retried(s, :incomplete, next, delay, fb, v["items"])
        end

      class ->
        # The model records the retry ceiling. Pick a valid maximum-jitter draw so that
        # the reference's randomized backoff is deterministic and matches that projection.
        seed_max_backoff(s)

        case Retry.next(s[:policy], s[:retry], class, remaining(s)) do
          :stop ->
            halt(s, reason(class), 4)

          {:retry, next, delay, fb} ->
            retried(s, class, next, delay, fb, v["items"])
        end
    end
  end

  defp apply_event("Result", _, s), do: %{s | "last" => "not_open"}

  defp apply_event("Checkpoint", v, %{"phase" => "open"} = s) do
    case v["kind"] do
      kind when kind in ["valid", "invalid", "oversized"] ->
        case checkpoint(kind) do
          {:ok, _, _} ->
            %{
              s
              | "phase" => "idle",
                "decision" => "checkpoint",
                "checkpoint" => "accepted",
                "continuations" => s["continuations"] + 1,
                "delay" => 0,
                "reason" => "",
                "continued" => false,
                "exit" => 0,
                "last" => "ok"
            }

          {:error, _} ->
            %{halt(s, "continuation_failed", 1) | "checkpoint" => "failed"}
        end

      _ ->
        %{s | "last" => "bad_checkpoint"}
    end
  end

  defp apply_event("Checkpoint", _, s), do: %{s | "last" => "not_open"}

  defp apply_event("SetWaited", %{"ms" => ms}, s) when ms in @waits, do: %{s | "waited" => ms, "last" => "ok"}
  defp apply_event("SetWaited", _, s), do: %{s | "last" => "bad_wait"}
  defp apply_event(_, _, s), do: %{s | "last" => "bad_event"}

  defp halt(s, why, code) do
    %{
      s
      | "phase" => "stopped",
        "decision" => "stop",
        "delay" => 0,
        "reason" => why,
        "continued" => false,
        "exit" => code,
        "queued" => true,
        "last" => "ok"
    }
  end

  defp remaining(%{"bounded" => true, "wall" => wall}), do: wall
  defp remaining(_), do: :infinity

  defp ceiling(n) when n <= 1, do: 2_000
  defp ceiling(2), do: 4_000
  defp ceiling(3), do: 8_000
  defp ceiling(4), do: 16_000
  defp ceiling(5), do: 32_000
  defp ceiling(_), do: 60_000

  defp seed_max_backoff(s) do
    cap = ceiling(s["attempt"])
    range = cap - div(cap, 2)
    seeds = Process.get(:max_backoff_seeds, %{})

    {seed, seeds} =
      case Map.fetch(seeds, range) do
        {:ok, seed} -> {seed, seeds}
        :error ->
          seed =
            Enum.find(1..(range * 8), fn candidate ->
              :rand.seed(:exsss, {candidate, candidate + 1, candidate + 2})
              :rand.uniform(range) == range
            end) || raise "could not find deterministic maximum backoff seed"

          {seed, Map.put(seeds, range, seed)}
      end

    Process.put(:max_backoff_seeds, seeds)
    :rand.seed(:exsss, {seed, seed + 1, seed + 2})
  end

  defp model_tuple("sol"), do: {"gpt-6.1-sol", "medium"}
  defp model_tuple("luna"), do: {"gpt-6-luna", "max"}

  defp show({"gpt-6.1-sol", _}), do: "sol"
  defp show({"gpt-6-luna", _}), do: "luna"
  defp show({name, _}), do: name

  defp klass("ok", _), do: :ok
  defp klass("first_byte", _), do: :timeout
  defp klass("total", _), do: :timeout
  defp klass("stall", _), do: :stall
  defp klass("cut", true), do: :malformed
  defp klass("cut", false), do: :transport
  defp klass(kind, _) when kind in ["overload", "malformed", "transport", "timeout", "usage_limit", "login", "incomplete"],
    do: String.to_atom(kind)
  defp klass(_, _), do: :bad

  defp reason(:timeout), do: "provider/timeout"
  defp reason(:stall), do: "provider/stall"
  defp reason(:transport), do: "provider/transport"
  defp reason(:overload), do: "provider/overload"
  defp reason(:malformed), do: "provider/malformed"
  defp reason(:usage_limit), do: "provider/usage_limit"
  defp reason(:login), do: "provider/login"
  defp reason("continuation_failed"), do: "continuation_failed"
  defp reason(_), do: ""

  defp retried(s, class, next, delay, fallback, items) do
    cap = ceiling(s["attempt"])

    reported =
      cond do
        fallback -> 0
        delay >= div(cap, 2) and delay <= cap -> cap
        true -> delay
      end

    %{
      s
      | :retry => next,
        "phase" => "open",
        "model" => show(next.model),
        "attempt" => next.attempt,
        "overloads" => next.overloads,
        "decision" => if(fallback, do: "switch", else: "retry"),
        "delay" => reported,
        "reason" => reason(class),
        "continued" => continued?(class, items),
        "exit" => 0,
        "last" => "ok"
    }
  end

  defp continued?(_class, false), do: false

  defp continued?(class, true) do
    request = Kogen.Harness.Codec.request("gpt-6-luna", "medium", "", [], [])

    error = %Kogen.Contracts.ProviderError{
      class: class,
      message: "adapter partial stream",
      partial_items: [%{"type" => "output_text", "text" => "received progress"}]
    }

    Kogen.Resilience.Recovery.continue(request, error).continuation_items != []
  end

  defp checkpoint("valid"), do: run_checkpoint(@checkpoint_text, [String.duplicate("x", 20_000)], 100_000)
  defp checkpoint("invalid"), do: run_checkpoint("nope", ["x"], 100_000)
  defp checkpoint("oversized"), do: run_checkpoint(@checkpoint_text, ["x"], 16)

  defp run_checkpoint(text, items, limit) do
    response = %{
      __struct__: Kogen.Contracts.ModelResponse,
      id: "r",
      text: text,
      tool_calls: [],
      usage: %{},
      raw_items: []
    }

    path = Path.join(System.tmp_dir!(), "kogen-stream-checkpoint.txt")
    Kogen.Conversation.checkpoint(response, "approved", items, limit, path)
  end

  def loop(state) do
    case IO.binread(:stdio, :line) do
      :eof ->
        :ok

      {:error, _} ->
        :ok

      line ->
        state = handle(JSON.decode!(String.trim(line)), state)
        IO.binwrite(:stdio, [JSON.encode!(observe(state)), "\n"])
        loop(state)
    end
  end
end

Adapter.loop(Adapter.init())
