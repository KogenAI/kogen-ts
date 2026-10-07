# JSON-lines adapter. Intent approve/remove/shape in the reference is Kernel.CLI plus
# ApprovalStore over git. There is no pure apply/2. This process answers every request
# so the harness can record the miss; it does not reimplement the policy.
defmodule Adapter do
  def observe do
    %{
      "last" => "no_seam",
      "exit" => 70,
      "did" => "",
      "shown" => "",
      "casTries" => 0,
      "life" => %{},
      "refs" => %{}
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
