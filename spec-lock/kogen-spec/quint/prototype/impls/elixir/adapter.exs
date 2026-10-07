# xspec/1 adapter: JSON lines on stdin -> one observation line on stdout per request.

defmodule Adapter do
  def decode_event(%{"tag" => "Approve", "value" => %{"slug" => slug, "time" => t}})
      when is_binary(slug) and is_integer(t),
      do: {:ok, {:approve, slug, t}}

  def decode_event(%{"tag" => "Start", "value" => id}) when is_binary(id), do: {:ok, {:start, id}}
  def decode_event(%{"tag" => "Gate", "value" => v}) when is_boolean(v), do: {:ok, {:gate, v}}
  def decode_event(%{"tag" => "Step"}), do: {:ok, :step}
  def decode_event(%{"tag" => "Crash"}), do: {:ok, :crash}
  def decode_event(%{"tag" => "Interrupt"}), do: {:ok, :interrupt}
  def decode_event(%{"tag" => "PushExternal", "value" => id}) when is_binary(id), do: {:ok, {:push_external, id}}
  def decode_event(%{"tag" => "Recover"}), do: {:ok, :recover}
  def decode_event(%{"tag" => "Init"}), do: {:ok, :init}
  def decode_event(other), do: {:error, other}

  def handle(%{"op" => "reset"}, _state), do: Landing.initial()

  def handle(%{"op" => "apply", "event" => e}, state) do
    case decode_event(e) do
      {:ok, ev} -> Landing.apply(state, ev)
      {:error, bad} ->
        IO.puts(:stderr, "bad event: #{inspect(bad)}")
        %{state | last: "bad_event"}
    end
  end

  def handle(other, state) do
    IO.puts(:stderr, "bad request: #{inspect(other)}")
    %{state | last: "bad_request"}
  end

  def loop(state) do
    case IO.binread(:stdio, :line) do
      :eof -> :ok
      {:error, _} -> :ok
      line ->
        case String.trim(line) do
          "" -> loop(state)
          text ->
            state =
              case JSON.decode(text) do
                {:ok, req} -> handle(req, state)
                {:error, _} ->
                  IO.puts(:stderr, "bad json: #{text}")
                  %{state | last: "bad_request"}
              end

            IO.binwrite(:stdio, [JSON.encode!(Landing.observe(state)), "\n"])
            loop(state)
        end
    end
  end
end

Adapter.loop(Landing.initial())
