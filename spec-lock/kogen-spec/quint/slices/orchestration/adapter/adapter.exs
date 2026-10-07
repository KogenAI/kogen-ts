# The reference engine is not the B0–B10 table. The adapter answers so the harness
# can show the miss; it does not invent the policy.
defmodule Adapter do
  def observe do
    %{
      "last" => "no_seam",
      "exit" => 70,
      "phase" => "",
      "status" => "",
      "reason" => "",
      "rung" => 0,
      "entry" => 0,
      "claim" => false,
      "planned" => false,
      "landable" => false,
      "parkedRef" => false,
      "repairs" => 0,
      "granted" => 0,
      "snapshots" => 0,
      "journal" => []
    }
  end

  def loop do
    case IO.binread(:stdio, :line) do
      :eof -> :ok
      {:error, _} -> :ok
      line ->
        _ = JSON.decode!(String.trim(line))
        IO.binwrite(:stdio, [JSON.encode!(observe()), "\n"])
        loop()
    end
  end
end

Adapter.loop()
