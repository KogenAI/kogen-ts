# xspec/1 adapter. The conversation key is Kogen.Conversation.PromptCacheKey from T98,
# loaded from source. cache_epoch and the ChatGPT codec come from the T98 beams:
# conversation.ex uses Boundary, which will not compile outside Mix, and that beam is
# newer than the source. keyChanged is the real hash comparison. Lite reports v1 only
# when the code's session key is the spec's v1 material.
t98 = Path.expand("~/Areas/Kogen/careful-rebuild-wt/T98")
ebin_root = Path.join(t98, "_build/dev/lib")

for app <- File.ls!(ebin_root) do
  Code.append_path(Path.join([ebin_root, app, "ebin"]))
end

Code.require_file(Path.join(t98, "lib/kogen/conversation/prompt_cache_key.ex"))

defmodule Adapter do
  @dir "/tmp/kogen-session-run"
  @prefix "Continuation of the same approved Build.\n\n"

  def init do
    %{
      "version" => "",
      "stage" => "",
      "attempt" => "",
      "rung" => "",
      "epoch" => "",
      "epochClass" => "",
      "model" => "",
      "previous" => false,
      "keyChanged" => false,
      "lite" => "",
      "last" => "ok",
      :hash => "",
      :digest => ""
    }
  end

  def observe(s), do: Map.drop(s, [:hash, :digest])

  def handle(%{"op" => "reset"}, _), do: init()

  def handle(%{"op" => "apply", "event" => %{"tag" => tag} = event}, s),
    do: apply_event(tag, event["value"], s)

  def handle(_, s), do: %{s | "last" => "bad_event"}

  defp apply_event("Init", _, _), do: init()

  defp apply_event("Bind", v, s) do
    stage = v["stage"]
    attempt = v["attempt"]
    rung = v["rung"]

    cond do
      stage not in ["develop", "plan"] or attempt not in ["", "builder", "fresh-1", "fresh-2", "escalation"] or
          rung not in ["", "builder", "1", "2", "fresh-1"] ->
        %{s | "last" => "bad_bind"}

      true ->
        attempt = if(attempt == "", do: "builder", else: attempt)
        rung = if(rung == "", do: attempt, else: rung)

        stamp(s, %{
          "version" => "v2",
          "stage" => stage,
          "attempt" => attempt,
          "rung" => rung,
          "epoch" => "initial",
          "epochClass" => "initial",
          "last" => "ok"
        })
    end
  end

  defp apply_event(tag, _, %{"version" => version} = s)
       when tag in ["Turn", "Repair"] and version != "v2",
       do: %{s | "last" => "not_bound"}

  defp apply_event(tag, _, s) when tag in ["Turn", "Repair"],
    do: stamp(s, %{"last" => "ok"})

  defp apply_event("Model", %{"name" => name}, %{"version" => "v2"} = s) when name in ["luna", "sol"],
    do: stamp(s, %{"model" => name, "last" => "ok"})

  defp apply_event("Model", _, %{"version" => "v2"} = s), do: %{s | "last" => "bad_model"}
  defp apply_event("Model", _, s), do: %{s | "last" => "not_bound"}

  defp apply_event("Stage", %{"name" => name}, %{"version" => "v2"} = s) when name in ["develop", "plan"],
    do: stamp(s, %{"stage" => name, "last" => "ok"})

  defp apply_event("Stage", _, %{"version" => "v2"} = s), do: %{s | "last" => "bad_bind"}
  defp apply_event("Stage", _, s), do: %{s | "last" => "not_bound"}

  defp apply_event("Attempt", %{"name" => name}, %{"version" => "v2"} = s)
       when name in ["builder", "fresh-1", "fresh-2", "escalation"],
       do: stamp(s, %{"attempt" => name, "last" => "ok"})

  defp apply_event("Attempt", _, %{"version" => "v2"} = s), do: %{s | "last" => "bad_bind"}
  defp apply_event("Attempt", _, s), do: %{s | "last" => "not_bound"}

  defp apply_event("Rung", %{"name" => name}, %{"version" => "v2"} = s)
       when name in ["1", "2", "builder", "fresh-1"],
       do: stamp(s, %{"rung" => name, "last" => "ok"})

  defp apply_event("Rung", _, %{"version" => "v2"} = s), do: %{s | "last" => "bad_bind"}
  defp apply_event("Rung", _, s), do: %{s | "last" => "not_bound"}

  defp apply_event("Epoch", %{"name" => "mutation-advice"}, %{"version" => "v2"} = s),
    do:
      stamp(s, %{
        "epoch" => "mutation-advice",
        "epochClass" => "mutation-advice",
        "last" => "ok"
      })

  defp apply_event("Epoch", %{"name" => "summarizer"}, %{"version" => "v2"} = s),
    do: stamp(s, %{"epoch" => "checkpoint-1", "epochClass" => "checkpoint", "last" => "ok"})

  defp apply_event("Epoch", _, %{"version" => "v2"} = s), do: %{s | "last" => "bad_epoch"}
  defp apply_event("Epoch", _, s), do: %{s | "last" => "not_bound"}

  defp apply_event("Accept", %{"ok" => true}, %{"version" => "v2"} = s) do
    case Kogen.Conversation.cache_epoch(prefix_items()) do
      digest when is_binary(digest) ->
        stamp(%{s | :digest => digest}, %{
          "epoch" => "digest",
          "epochClass" => "checkpoint",
          "last" => "ok"
        })

      _ ->
        %{s | "last" => "no_epoch"}
    end
  end

  defp apply_event("Accept", %{"ok" => false}, %{"version" => "v2"} = s) do
    case Kogen.Conversation.cache_epoch(other_items()) do
      nil -> %{s | "last" => "no_epoch"}
      _ -> stamp(s, %{"epoch" => "digest", "epochClass" => "checkpoint", "last" => "ok"})
    end
  end

  defp apply_event("Accept", _, s), do: %{s | "last" => "not_bound"}

  # The codec decides. The model refuses this event; a body that contains the field diverges.
  defp apply_event("Previous", _, s) do
    if sends_previous?(),
      do: %{s | "previous" => true, "last" => "sent"},
      else: %{s | "previous" => false, "last" => "never_sent"}
  end

  defp apply_event("Lite", _, s) do
    %{s | "lite" => lite_material(), "keyChanged" => false, "last" => "ok"}
  end

  defp apply_event(_, _, s), do: %{s | "last" => "bad_event"}

  defp stamp(s, fields) do
    next = Map.merge(s, fields)
    hash = key_for(next)
    old = s[:hash]
    %{next | :hash => hash, "keyChanged" => old != "" and hash != old}
  end

  defp key_for(%{"stage" => stage, "attempt" => attempt, "rung" => rung, "epoch" => epoch} = s) do
    token = if(epoch == "digest", do: s[:digest], else: epoch)

    Kogen.Conversation.PromptCacheKey.for_run_stage(@dir, String.to_atom(stage), %{
      attempt: attempt,
      rung: rung,
      cache_epoch: token
    })
  end

  defp prefix_items do
    ["approved", %{"content" => [%{"text" => @prefix <> "summary"}]}, "tail"]
  end

  defp other_items do
    ["approved", %{"content" => [%{"text" => "nope"}]}]
  end

  defp lite_material do
    session = Kogen.Conversation.PromptCacheKey.for_run_stage(@dir, :session)

    v1 =
      :crypto.hash(:sha256, ["kogen:responses:v1\0", Path.expand(@dir), "\0", "session"])
      |> Base.encode16(case: :lower)

    if session == v1, do: "v1", else: "v2"
  end

  defp sends_previous? do
    request = Kogen.Harness.Codec.request("gpt-6-luna", "medium", "", [], [])

    case Kogen.Provider.ChatGPT.Codec.encode_request(request, :codex) do
      {:ok, bin} -> :binary.match(bin, "previous_response_id") != :nomatch
      _ -> false
    end
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
