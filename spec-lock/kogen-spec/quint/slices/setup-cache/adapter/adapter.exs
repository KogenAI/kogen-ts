# xspec/1 adapter. Runs the read-only reference's real setup cache against isolated temporary
# workspaces and a temporary cache root. No Kogen checkout files are changed.
ebin = Path.expand("~/Areas/Kogen/careful-rebuild/_build/dev/lib/kogen/ebin")
Code.append_path(ebin)

defmodule Adapter do
  alias Kogen.Contracts.Project
  alias Kogen.Project.SetupReuse

  def init do
    root = Path.join(System.tmp_dir!(), "kogen-setup-cache-xspec-#{System.unique_integer([:positive])}")
    File.rm_rf(root)
    File.mkdir_p!(root)

    %{
      "entryCount" => 0,
      "work" => "",
      "present" => false,
      "reused" => false,
      "setupRuns" => 0,
      "last" => "ok",
      :root => root,
      :workdir => nil,
      :seq => 0
    }
  end

  def observe(s), do: Map.drop(s, [:root, :workdir, :seq])

  def handle(%{"op" => "reset"}, s) do
    File.rm_rf(s[:root])
    init()
  end

  def handle(%{"op" => "apply", "event" => %{"tag" => "Run", "value" => value}}, s),
    do: run(value, s)

  def handle(%{"op" => "apply", "event" => %{"tag" => "Mutate", "value" => value}}, s),
    do: mutate(value, s)

  def handle(%{"op" => "apply", "event" => %{"tag" => "Init"}}, s), do: init_with_root(s[:root])
  def handle(_, s), do: %{s | "last" => "bad_event"}

  defp init_with_root(root) do
    File.rm_rf(root)
    File.mkdir_p!(root)

    %{
      "entryCount" => 0,
      "work" => "",
      "present" => false,
      "reused" => false,
      "setupRuns" => 0,
      "last" => "ok",
      :root => root,
      :workdir => nil,
      :seq => 0
    }
  end

  defp run(v, s) do
    seq = s[:seq] + 1
    workdir = Path.join(s[:root], "work-#{seq}")
    cache = Path.join(s[:root], "setup-cache")
    File.mkdir_p!(workdir)

    tracked = v["tracked"]
    if tracked, do: File.write!(Path.join(workdir, "input.txt"), v["input"])

    project = %Project{
      root: workdir,
      name: "xspec",
      checks: [],
      setup: if(v["enabled"], do: ["setup"], else: []),
      fix: [],
      diagnose: [],
      protected_paths: [],
      domains: %{},
      setup_outputs: if(v["enabled"], do: ["result.txt"], else: []),
      setup_inputs: if(tracked, do: ["input.txt"], else: nil),
      env: if(v["variant"] == "", do: %{}, else: %{"CACHE_VARIANT" => v["variant"]})
    }

    base = String.duplicate(v["base"], 40)
    toolchain = %{"PATH" => "/usr/bin:/bin", "ELIXIR_VERSION" => System.version()}

    runner = fn ->
      if v["ok"] do
        File.write!(Path.join(workdir, "result.txt"), v["payload"])
        if tracked and not v["stable"], do: File.write!(Path.join(workdir, "input.txt"), "changed-during-setup")
        :ok
      else
        {:error, :setup_failed}
      end
    end

    result = SetupReuse.run(project, workdir, cache, base, toolchain, runner)
    reused = match?({:ok, %{reused?: true}}, result)
    ok = match?({:ok, _}, result)
    content = if ok, do: read_output(workdir), else: ""

    %{
      s
      | "entryCount" => cache_entries(cache),
        "work" => content,
        "present" => ok and File.regular?(Path.join(workdir, "result.txt")),
        "reused" => reused,
        "setupRuns" => s["setupRuns"] + if(reused, do: 0, else: 1),
        "last" => if(reused, do: "hit", else: if(ok, do: "miss", else: "failed")),
        :workdir => workdir,
        :seq => seq
    }
  end

  defp mutate(_v, %{workdir: nil} = s), do: %{s | "last" => "no_output"}

  defp mutate(v, s) do
    path = Path.join(s[:workdir] || "", "result.txt")

    if File.regular?(path) do
      File.write!(path, v["payload"])
      %{s | "work" => v["payload"], "last" => "ok"}
    else
      %{s | "last" => "no_output"}
    end
  end

  defp read_output(workdir) do
    case File.read(Path.join(workdir, "result.txt")) do
      {:ok, content} -> content
      _ -> ""
    end
  end

  defp cache_entries(cache) do
    case File.ls(cache) do
      {:ok, names} ->
        Enum.count(names, fn name ->
          Regex.match?(~r/\A[0-9a-f]{64}\z/, name) and
            File.regular?(Path.join([cache, name, "complete"]))
        end)

      _ ->
        0
    end
  end

  def loop(state) do
    case IO.binread(:stdio, :line) do
      :eof ->
        File.rm_rf(state[:root])
        :ok

      {:error, _} ->
        File.rm_rf(state[:root])
        :ok

      line ->
        response =
          case Kogen.Contracts.JSON.decode(line) do
            {:ok, request} -> handle(request, state)
            _ -> %{state | "last" => "bad_json"}
          end

        IO.puts(observe(response) |> :json.encode() |> IO.iodata_to_binary())
        loop(response)
    end
  end
end

Adapter.loop(Adapter.init())
