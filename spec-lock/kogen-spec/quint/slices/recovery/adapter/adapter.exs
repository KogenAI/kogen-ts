# Recovery walks run.json, git, and process liveness. There is no pure apply.
# The process answers so the harness can record the miss. It does not reimplement §3.10.
defmodule Adapter do
  def observe do
    %{
      "last" => "no_seam",
      "line" => "no_seam",
      "claim" => "",
      "runs" => %{}
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
