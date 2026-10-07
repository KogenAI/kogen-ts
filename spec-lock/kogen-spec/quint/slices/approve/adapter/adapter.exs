# JSON-lines adapter for the approval slice. The current Kogen path is
# Approval.prepare (filesystem, Git, setup and checks) plus private CLI decide/2;
# it has no pure apply/2 seam. Return an explicit miss for every request instead
# of deriving a false conformance result from the event inputs.
defmodule Adapter do
  @obs %{
    "last" => "no_seam", "exit" => 70, "sha8" => "", "approver" => "", "feas" => "",
    "bwarn" => false, "lwarn" => false, "ran" => false, "checkRuns" => 0, "cache" => "",
    "approvals" => %{}
  }

  def loop do
    case IO.binread(:stdio, :line) do
      :eof -> :ok
      {:error, _} -> :ok
      line ->
        _ = JSON.decode!(String.trim(line))
        IO.binwrite(:stdio, [JSON.encode!(@obs), "\n"])
        loop()
    end
  end
end

Adapter.loop()
