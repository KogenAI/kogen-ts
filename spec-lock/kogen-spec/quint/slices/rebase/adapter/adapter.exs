# Landing is Workspace.Landing over git. There is no pure apply. The process answers
# so the harness can record the miss. It does not reimplement §3.9.
defmodule Adapter do
  def observe do
    %{
      "last" => "no_seam",
      "line" => "no_seam",
      "exit" => 70,
      "phase" => "",
      "status" => "",
      "reason" => "",
      "recorded" => false,
      "incoming" => false,
      "onBase" => false,
      "claim" => false,
      "tries" => 0,
      "repairs" => 0,
      "delay" => 0,
      "warning" => false,
      "cleanup" => false
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
