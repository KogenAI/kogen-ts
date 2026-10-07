/** Source loaded by Elixir from the private run directory. */
export const EXUNIT_LEDGER_FORMATTER_SOURCE = String.raw`defmodule KogenLedgerFormatter do
  use GenServer

  def init(_opts) do
    {:ok, %{report_path: System.fetch_env!("KOGEN_LEDGER_REPORT")}}
  end

  def handle_cast({:test_finished, test}, state) do
    tag =
      case Map.get(test.tags, :intent) do
        value when is_binary(value) -> value
        _ -> "<untagged>"
      end

    name = test.name |> Atom.to_string() |> String.replace_prefix("test ", "")
    status =
      case test.state do
        nil -> "passed"
        {:failed, _} -> "failed"
        {:skipped, _} -> "skipped"
        {:excluded, _} -> "excluded"
        {:invalid, _} -> "invalid"
        _ -> "invalid"
      end

    row =
      "{\"tag\":#{json_string(tag)},\"test\":#{json_string(name)},\"status\":#{json_string(status)}}\n"

    File.write!(state.report_path, row, [:append, :binary])
    {:noreply, state}
  end

  def handle_cast(_event, state), do: {:noreply, state}

  defp json_string(value) do
    escaped =
      value
      |> String.to_charlist()
      |> Enum.map_join(fn
        ?" -> "\\\""
        ?\\ -> "\\\\"
        ?\b -> "\\b"
        ?\f -> "\\f"
        ?\n -> "\\n"
        ?\r -> "\\r"
        ?\t -> "\\t"
        code when code < 0x20 ->
          "\\u" <> (code |> Integer.to_string(16) |> String.pad_leading(4, "0"))

        codepoint -> <<codepoint::utf8>>
      end)

    "\"" <> escaped <> "\""
  end
end
`;
